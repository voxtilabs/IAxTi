import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { fuenteLimpia } from '@iaxti/core/testing';
import { receiveInbound } from '@iaxti/module-conversations';
import { processSuggest } from '../src/copilot';

/**
 * Dos mensajes seguidos, UNA respuesta (#1223).
 *
 * Medido antes de esto, con el dueño escribiendo desde su teléfono: «Hola» y
 * «Sigo vivo» en el mismo minuto recibieron dos respuestas completas, con
 * firma las dos. Nadie escribe un mensaje por idea —llega el saludo, después
 * la consulta— así que no es un caso raro: es el caso normal, y recibir tres
 * párrafos encima es lo que delata a un bot.
 */
const generadas: string[] = [];
vi.mock('@iaxti/module-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@iaxti/module-agents')>()),
  providerAvailable: () => true,
  autoRespondForInbound: async () => {
    generadas.push('una');
    return { action: 'reply', text: 'Te ayudo', agentName: 'Asistente',
    // La clasificación viaja con la respuesta (#1243). `consulta`/`frio` para
    // que estas pruebas midan la ENTREGA y no de paso el embudo.
    clasificacion: { intencion: 'consulta', calificacion: 'frio' } };
  },
}));

let pool: Pool;
let tenantId: string;
beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenantId = (await pool.query("INSERT INTO tenants (name) VALUES ('esperar-escribir') RETURNING id")).rows[0].id;
});
afterAll(async () => {
  await pool.query('DELETE FROM processed_events WHERE event_id IN (SELECT id FROM outbox WHERE tenant_id=$1)', [tenantId]);
  await pool.query('DELETE FROM outbox WHERE tenant_id=$1', [tenantId]);
  await pool.end();
});

describe('se espera a que la persona termine de escribir (#1223)', () => {
  it('con dos mensajes seguidos contesta UNA vez, y es el último el que contesta', async () => {
    generadas.length = 0;
    const primero = await withTenant(pool, tenantId, (c) =>
      receiveInbound(c, { tenantId, channel: 'whatsapp', phone: '+56922220001', body: 'hola' }),
    );
    const segundo = await withTenant(pool, tenantId, (c) =>
      receiveInbound(c, { tenantId, channel: 'whatsapp', phone: '+56922220001', body: 'sigo vivo' }),
    );
    // Los dos jobs corren, en el orden en que se encolaron.
    const uno = await processSuggest(pool, {
      tenantId,
      conversationId: primero.conversation.id,
      messageId: primero.message.id,
      requestId: 'req-espera-1',
    });
    const dos = await processSuggest(pool, {
      tenantId,
      conversationId: segundo.conversation.id,
      messageId: segundo.message.id,
      requestId: 'req-espera-2',
    });
    // Lo que de verdad importa primero: UN saliente, no dos. Afirmar el texto
    // del `skipped` antes daba un error confuso cuando el guardia no estaba
    // («undefined and string is invalid for this assertion») en vez de decir
    // que había dos respuestas.
    const salientes = await pool.query(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND direction='out'",
      [segundo.conversation.id],
    );
    expect(salientes.rows[0].n, 'tiene que haber UNA respuesta, no una por mensaje').toBe(1);
    // Una sola generación: el modelo no se paga dos veces tampoco.
    expect(generadas).toHaveLength(1);
    expect(uno.autoReplied).toBeUndefined();
    expect(dos.autoReplied).toBeDefined();
    // Y el que se saltó lo DICE: un `skipped` sin motivo deja a quien mira el
    // log sin saber si fue esto o un fallo.
    expect(uno.skipped ?? '').toContain(// El texto cambió con #1245: el guardia ya no cuenta solo entrantes, así
      // que «otro mensaje» se quedaba corto. El comportamiento que esta
      // prueba fija —contesta UNA vez, la del último— no cambió.
      'pasó algo después');
  });

  it('un mensaje solo se contesta igual: la espera no se come el caso normal', async () => {
    generadas.length = 0;
    const solo = await withTenant(pool, tenantId, (c) =>
      receiveInbound(c, { tenantId, channel: 'whatsapp', phone: '+56922220002', body: 'una consulta' }),
    );
    const r = await processSuggest(pool, {
      tenantId,
      conversationId: solo.conversation.id,
      messageId: solo.message.id,
      requestId: 'req-espera-3',
    });
    expect(r.autoReplied).toBeDefined();
    expect(generadas).toHaveLength(1);
  });
});

/**
 * Y que el respiro exista al encolar, mirado en el entrypoint de workers.
 *
 * Sin el `delay`, los dos jobs corren pegados al entrante y el de arriba no
 * alcanza a ver el mensaje siguiente: las dos mitades hacen falta.
 */
describe('el respiro al encolar (#1223)', () => {
  const MAIN = fuenteLimpia(
    readFileSync(join(__dirname, '..', '..', 'workers', 'src', 'main.ts'), 'utf8'),
  );

  it('el job de la IA se encola con delay y sale del entorno', () => {
    expect(MAIN).toMatch(/const ESPERA_PARA_TERMINAR_MS = enteroDeEntorno\('AGENTS_ESPERA_MS', [1-9]/);
    const bloque = MAIN.slice(MAIN.indexOf("'suggest',"), MAIN.indexOf('.catch(', MAIN.indexOf("'suggest',")));
    expect(bloque).toContain('delay: ESPERA_PARA_TERMINAR_MS');
  });
});
