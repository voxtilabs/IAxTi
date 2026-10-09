import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import { createRule, setRuleActive } from '../application/rules';
import { correrReglasDeEntrada, handleAutomationEvent } from '../application/engine';

/**
 * Las reglas de entrada corren ANTES de que el bot conteste (#720).
 *
 * En el job de entrada, el copiloto se encolaba en el mismo instante en que
 * entraba el mensaje, y las reglas de `automations` corrían después —cuando el
 * publicador vaciaba el outbox—. O sea: la regla que debía enrutar el lead
 * llegaba cuando el bot ya había hablado por el negocio.
 *
 * Antes daba casi igual porque el copiloto respondía ciego. Desde #716 contesta
 * el primer mensaje CON herramientas.
 *
 * Lo que estas pruebas cuidan NO es el orden en sí —eso vive en el worker— sino
 * la propiedad que hace que el arreglo sea seguro: **que correr en línea no
 * haga que la regla corra dos veces**. Una regla con `send_message` que corre
 * dos veces le manda dos mensajes al cliente.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const TODOS = ['conversations', 'crm'];

let admin: Pool;
let tenant: string;
let usuario: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (
    await admin.query("INSERT INTO tenants (name) VALUES ('reglas-de-entrada') RETURNING id")
  ).rows[0].id;
  // El dueño es un uuid: `assignConversation` guarda a quién, no valida perfil.
  usuario = randomUUID();
});

afterAll(async () => {
  for (const tabla of ['rule_runs', 'rules', 'assignments', 'messages', 'conversations', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

/** Una conversación nueva, como la que crea un WhatsApp que llega. */
async function conversacionNueva(): Promise<{ conversationId: string; messageId: string }> {
  const r = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: `+5695555${Math.floor(Math.random() * 9000 + 1000)}`,
      channel: 'simulador',
      body: 'Hola, ¿cuánto cuesta el despacho?',
    }),
  );
  return { conversationId: r.conversation.id, messageId: r.message.id };
}

/** Una regla activa que asigna la conversación a `usuario`. */
async function reglaQueAsigna(): Promise<string> {
  const regla = await withTenant(admin, tenant, (c) =>
    createRule(c, {
      tenantId: tenant,
      name: `asignar-${Math.random().toString(36).slice(2, 8)}`,
      trigger: { kind: 'event', event: 'conversation.created' },
      conditions: [],
      actions: [{ kind: 'assign', params: { toOwnerId: usuario } }],
      actor: 'test',
    }),
  );
  await withTenant(admin, tenant, (c) =>
    setRuleActive(c, { tenantId: tenant, ruleId: regla.id, active: true, activeModules: TODOS, actor: 'test' }),
  );
  return regla.id;
}

async function corridas(reglaId: string, conversationId: string): Promise<number> {
  const r = await admin.query(
    'SELECT count(*)::int AS n FROM rule_runs WHERE rule_id = $1 AND object_id = $2',
    [reglaId, conversationId],
  );
  return r.rows[0].n;
}

async function duenoDe(conversationId: string): Promise<string | null> {
  return (await admin.query('SELECT owner_id FROM conversations WHERE id = $1', [conversationId]))
    .rows[0].owner_id;
}

/** El sobre que publica el outbox para una conversación nueva. */
function sobre(conversationId: string, id: number) {
  return {
    id,
    name: 'conversation.created',
    tenantId: tenant,
    payload: { conversationId },
    actor: 'test',
    requestId: null,
    version: 1,
    occurredAt: new Date(),
  } as never;
}

describe('correr las reglas de entrada en línea (#720)', () => {
  it('asigna la conversación, que es lo que el bot necesitaba que pasara antes', async () => {
    const reglaId = await reglaQueAsigna();
    const { conversationId, messageId } = await conversacionNueva();

    const n = await withTenant(admin, tenant, (c) =>
      correrReglasDeEntrada(
        c,
        { tenantId: tenant, conversationId, eventoId: messageId },
        { activeModules: TODOS },
      ),
    );

    expect(n).toBe(1);
    expect(await duenoDe(conversationId), 'tiene dueño antes de que el copiloto hable').toBe(usuario);
    expect(await corridas(reglaId, conversationId)).toBe(1);
  });

  it('el outbox DESPUÉS no la vuelve a correr: comparten la clave', async () => {
    // Ésta es la propiedad que hace seguro correr en línea sin sacar el
    // consumidor. Una regla con `send_message` que corre dos veces le manda dos
    // mensajes al cliente, y eso no se arregla con una disculpa.
    const reglaId = await reglaQueAsigna();
    const { conversationId, messageId } = await conversacionNueva();

    await withTenant(admin, tenant, (c) =>
      correrReglasDeEntrada(
        c,
        { tenantId: tenant, conversationId, eventoId: messageId },
        { activeModules: TODOS },
      ),
    );
    await withTenant(admin, tenant, (c) =>
      handleAutomationEvent(sobre(conversationId, 720001), c, { activeModules: TODOS }),
    );

    expect(await corridas(reglaId, conversationId), 'una sola corrida, no dos').toBe(1);
  });

  it('y al revés: si la de en línea no alcanzó a correr, el outbox la rescata', async () => {
    // El presupuesto del job de entrada puede vencerse. Que el consumidor siga
    // ahí es la red — por eso NO se sacó.
    const reglaId = await reglaQueAsigna();
    const { conversationId } = await conversacionNueva();

    await withTenant(admin, tenant, (c) =>
      handleAutomationEvent(sobre(conversationId, 720002), c, { activeModules: TODOS }),
    );

    expect(await corridas(reglaId, conversationId)).toBe(1);
    expect(await duenoDe(conversationId)).toBe(usuario);
  });

  it('dos conversaciones distintas corren cada una la suya', async () => {
    // La clave es por objeto: si fuera solo por regla, la segunda conversación
    // se quedaría sin enrutar para siempre.
    const reglaId = await reglaQueAsigna();
    const a = await conversacionNueva();
    const b = await conversacionNueva();

    for (const { conversationId, messageId } of [a, b]) {
      await withTenant(admin, tenant, (c) =>
        correrReglasDeEntrada(
          c,
          { tenantId: tenant, conversationId, eventoId: messageId },
          { activeModules: TODOS },
        ),
      );
    }

    expect(await corridas(reglaId, a.conversationId)).toBe(1);
    expect(await corridas(reglaId, b.conversationId)).toBe(1);
  });

  it('sin reglas activas no hace nada y no revienta', async () => {
    const otro = (
      await admin.query("INSERT INTO tenants (name) VALUES ('sin-reglas') RETURNING id")
    ).rows[0].id;
    const r = await withTenant(admin, otro, (c) =>
      receiveInbound(c, { tenantId: otro, phone: '+56955559999', channel: 'simulador', body: 'hola' }),
    );
    const n = await withTenant(admin, otro, (c) =>
      correrReglasDeEntrada(
        c,
        { tenantId: otro, conversationId: r.conversation.id, eventoId: r.message.id },
        { activeModules: TODOS },
      ),
    );
    expect(n).toBe(0);
    for (const tabla of ['messages', 'conversations', 'contacts', 'outbox']) {
      await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [otro]);
    }
  });
});
