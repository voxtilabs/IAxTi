import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound, sendMessage } from '@iaxti/module-conversations';
import { processSuggest } from '../src/copilot';

/**
 * El bot no habla encima de quien ya contestó (#1245).
 *
 * El caso caro, y el que hace falta medir: el cliente escribe, el bot empieza
 * a generar —tarda unos 20 s— y mientras tanto el dueño contesta desde su
 * teléfono. Ese mensaje entra a la bandeja por el eco (#1265), y hasta ahora
 * el bot no lo miraba: el cliente recibía DOS respuestas distintas.
 *
 * El guardia que existía solo contaba ENTRANTES posteriores, así que un
 * saliente de una persona le era invisible. Y preguntaba una sola vez, al
 * arrancar — cuando todavía era cierto que le tocaba.
 */
vi.mock('@iaxti/module-agents', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  // Sin credenciales reales: lo que se prueba es la política del worker.
  providerAvailable: () => true,
  // La generación tarda: es la ventana donde cabe la carrera.
  autoRespondForInbound: async () => {
    await new Promise((listo) => setTimeout(listo, 300));
    return {
      action: 'reply',
      text: 'Te ayudo',
      agentName: 'Asistente',
      firma: '',
      executionId: randomUUID(),
      clasificacion: { intencion: 'consulta', calificacion: 'frio' },
    };
  },
}));


let pool: Pool;
let tenant: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants(name) VALUES('no habla encima') RETURNING id")).rows[0].id;
});
afterAll(async () => { await pool?.end(); });

/** Una conversación con un entrante, como la deja el camino de entrada. */
async function conversacionConEntrante() {
  return withTenant(pool, tenant, async (c) => {
    const r = await receiveInbound(c, {
      tenantId: tenant,
      channel: 'whatsapp',
      phone: `+569${String(Date.now()).slice(-8)}`,
      body: '¿tienen hora el jueves?',
      providerMessageId: `in-${randomUUID()}`,
    });
    return { conversationId: r.conversation.id, messageId: r.message.id };
  });
}

/** Cuántas veces habló el agente en esa conversación. */
async function dijoElAgente(conversationId: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int n FROM messages
      WHERE tenant_id = $1 AND conversation_id = $2 AND author_kind = 'agent'`,
    [tenant, conversationId],
  );
  return r.rows[0].n;
}

describe('el bot no habla encima de una persona (#1245)', () => {
  it('si el dueño ya contestó, el bot ni empieza', async () => {
    const { conversationId, messageId } = await conversacionConEntrante();
    // La persona contesta ANTES de que corra el job.
    await withTenant(pool, tenant, (c) =>
      sendMessage(c, {
        tenantId: tenant,
        conversationId,
        authorKind: 'user',
        type: 'texto',
        body: 'Hola, sí tenemos',
      }),
    );

    const r = await processSuggest(pool, { tenantId: tenant, conversationId, messageId });
    expect(r.skipped).toMatch(/pasó algo después/);
    expect(await dijoElAgente(conversationId)).toBe(0);
  });

  /**
   * LA carrera, que es lo que el issue nombra: el saliente de la persona
   * entra MIENTRAS el modelo genera. Preguntar solo al arrancar no la atrapa;
   * por eso hay una segunda pregunta justo antes de entregar.
   */
  it('si el dueño contesta MIENTRAS el bot genera, el bot no entrega', async () => {
    const { conversationId, messageId } = await conversacionConEntrante();

    const generando = processSuggest(pool, { tenantId: tenant, conversationId, messageId });
    // A mitad de la generación simulada (300 ms), contesta la persona.
    await new Promise((listo) => setTimeout(listo, 120));
    await withTenant(pool, tenant, (c) =>
      sendMessage(c, {
        tenantId: tenant,
        conversationId,
        authorKind: 'user',
        type: 'texto',
        body: 'Te respondo yo desde el teléfono',
      }),
    );

    const r = await generando;
    // El job termina BIEN —no es un error— y no entregó nada.
    expect(r.autoReplied ?? null).toBeNull();
    expect(await dijoElAgente(conversationId)).toBe(0);
  });

  /** Y sin nadie en el medio, el bot contesta como siempre. */
  it('sin nadie en el medio, el bot contesta igual', async () => {
    const { conversationId, messageId } = await conversacionConEntrante();
    const r = await processSuggest(pool, { tenantId: tenant, conversationId, messageId });
    expect(r.autoReplied).toBeTruthy();
    expect(await dijoElAgente(conversationId)).toBe(1);
  });

  /**
   * El caso que da nombre al issue: el job ENTREGÓ y murió antes de
   * terminar (despliegue, OOM). BullMQ re-toma el mismo job al vencer su
   * lock — la deduplicación por id no participa porque es EL MISMO job — y
   * sin idempotencia volvería a generar y a entregar: el cliente recibe la
   * respuesta DOS veces, con texto distinto.
   *
   * Acá el reintento es de verdad: una primera corrida entrega (la respuesta
   * queda en la conversación como saliente del agente, `seq` mayor que el
   * entrante), y el job SE VUELVE A CORRER con los mismos datos. El saliente
   * posterior del propio agente es la señal de que ya contestó — la
   * condición no filtra por autoría precisamente para que este caso entre.
   */
  it('el job reintentado después de haber entregado, no entrega DOS veces', async () => {
    const { conversationId, messageId } = await conversacionConEntrante();
    const job = { tenantId: tenant, conversationId, messageId };

    // Primera corrida: entrega y «muere» antes de marcar nada más.
    const primera = await processSuggest(pool, job);
    expect(primera.autoReplied).toBeTruthy();
    expect(await dijoElAgente(conversationId)).toBe(1);

    // El mismo job, de nuevo, como lo retoma BullMQ. Tiene que contestar
    // «ya está contestado» y NO agregar un segundo mensaje del agente.
    const reintento = await processSuggest(pool, job);
    expect(reintento.skipped).toMatch(/pasó algo después/);
    expect(await dijoElAgente(conversationId)).toBe(1);
  });

  /** Dos entrantes seguidos: el segundo se contesta igual — la idempotencia
      no puede quedarse con la pregunta nueva (eso se prueba, no se razona). */
  it('dos entrantes seguidos, el segundo se contesta', async () => {
    const { conversationId } = await conversacionConEntrante();
    // receiveInbound abre por contacto: el mismo teléfono cae en la misma
    // conversación, que es lo que este caso necesita. Se lee antes, porque
    // un `await` dentro del objeto argumento no compila.
    const telefono = (
      await pool.query(
        `SELECT c.phone FROM conversations cv JOIN contacts c ON c.id = cv.contact_id
          WHERE cv.tenant_id = $1 AND cv.id = $2`,
        [tenant, conversationId],
      )
    ).rows[0].phone;
    const r = await withTenant(pool, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        channel: 'whatsapp',
        phone: telefono,
        body: 'y el sábado?',
        providerMessageId: `in-${randomUUID()}`,
      }),
    );
    const segundo = await processSuggest(pool, {
      tenantId: tenant,
      conversationId,
      messageId: r.message.id,
    });
    expect(segundo.skipped).toBeUndefined();
    expect(segundo.autoReplied).toBeTruthy();
  });
});
