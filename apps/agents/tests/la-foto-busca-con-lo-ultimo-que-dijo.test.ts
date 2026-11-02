import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import { processSuggest } from '../src/copilot';

/**
 * Con qué texto se consulta el conocimiento cuando el mensaje no trae ninguno
 * (#1212).
 *
 * Medido en staging con una foto sin pie: el agente contestó «no tengo el
 * catálogo a mano» con cinco fuentes activas sin usar. El retrieval colgaba de
 * `if (pregunta)`, y `pregunta` era el `body` de ESE mensaje, que en una foto
 * es `null`.
 *
 * Las consultas se capturan en `consultas`: lo que importa de este arreglo es
 * exactamente qué se le pide al RAG, y eso no se ve en la respuesta.
 */
const consultas: string[] = [];
vi.mock('@iaxti/module-knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@iaxti/module-knowledge')>()),
  embeddingsAvailable: () => true,
  searchKnowledge: async (_c: unknown, input: { query: string }) => {
    consultas.push(input.query);
    return { hits: [], cached: false, expiredSources: [] };
  },
  knowledgeContext: () => 'CONOCIMIENTO DEL NEGOCIO (de prueba)',
  fuentesCitadas: () => [],
}));
vi.mock('@iaxti/module-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@iaxti/module-agents')>()),
  providerAvailable: () => true,
  autoRespondForInbound: async () => ({ action: 'reply', text: 'Dale', agentName: 'Asistente' }),
}));

let pool: Pool;
let tenantId: string;
beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenantId = (await pool.query("INSERT INTO tenants (name) VALUES ('foto-conocimiento') RETURNING id")).rows[0].id;
});
afterAll(async () => {
  await pool.query('DELETE FROM processed_events WHERE event_id IN (SELECT id FROM outbox WHERE tenant_id=$1)', [tenantId]);
  await pool.query('DELETE FROM outbox WHERE tenant_id=$1', [tenantId]);
  await pool.end();
});

describe('una foto sin pie no llega al modelo sin conocimiento (#1212)', () => {
  it('se consulta con lo último que dijo el cliente en esa conversación', async () => {
    consultas.length = 0;
    const primero = await withTenant(pool, tenantId, (c) =>
      receiveInbound(c, { tenantId, channel: 'whatsapp', phone: '+56911110001', body: 'tengo una barbería' }),
    );
    await processSuggest(pool, {
      tenantId,
      conversationId: primero.conversation.id,
      messageId: primero.message.id,
      knowledgeActivo: true,
      requestId: 'req-foto-1',
    });
    expect(consultas).toEqual(['tengo una barbería']);

    // Ahora la foto, en la MISMA conversación y sin una palabra.
    const foto = await withTenant(pool, tenantId, (c) =>
      receiveInbound(c, {
        tenantId,
        channel: 'whatsapp',
        phone: '+56911110001',
        type: 'imagen',
        attachments: [{ key: `${tenantId}/una.jpg`, contentType: 'image/jpeg' }],
      }),
    );
    await processSuggest(pool, {
      tenantId,
      conversationId: foto.conversation.id,
      messageId: foto.message.id,
      knowledgeActivo: true,
      requestId: 'req-foto-2',
    });
    // La segunda consulta es la que antes no existía.
    expect(consultas).toEqual(['tengo una barbería', 'tengo una barbería']);
  });

  /**
   * Y si la conversación ARRANCA con la foto, no se consulta nada.
   *
   * No es una degradación que haya que tapar: no hay con qué buscar, y
   * buscar con algo inventado sería peor que no buscar. El prompt ya sabe
   * qué hacer con un adjunto que no puede ver (#1208).
   */
  it('si el cliente nunca escribió nada, no se consulta', async () => {
    consultas.length = 0;
    const foto = await withTenant(pool, tenantId, (c) =>
      receiveInbound(c, {
        tenantId,
        channel: 'whatsapp',
        phone: '+56911110002',
        type: 'imagen',
        attachments: [{ key: `${tenantId}/otra.jpg`, contentType: 'image/jpeg' }],
      }),
    );
    await processSuggest(pool, {
      tenantId,
      conversationId: foto.conversation.id,
      messageId: foto.message.id,
      knowledgeActivo: true,
      requestId: 'req-foto-3',
    });
    expect(consultas).toEqual([]);
  });
});
