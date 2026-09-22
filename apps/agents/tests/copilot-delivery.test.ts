import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import { processSuggest } from '../src/copilot';

// El resultado del LLM es fijo; se prueban persistencia, identidad y política
// del worker real, sin credenciales ni mensajes a proveedores externos.
vi.mock('@iaxti/module-agents', async importOriginal => ({
  ...await importOriginal<typeof import('@iaxti/module-agents')>(),
  providerAvailable: () => true,
  autoRespondForInbound: async () => ({ action: 'reply', text: 'Te ayudo', agentName: 'Asistente' }),
}));

let pool: Pool;
let tenantId: string;
beforeAll(async () => {
  pool = createPool(); await runMigrations(pool);
  tenantId = (await pool.query("INSERT INTO tenants (name) VALUES ('copilot-durable') RETURNING id")).rows[0].id;
});
afterAll(async () => {
  await pool.query('DELETE FROM processed_events WHERE event_id IN (SELECT id FROM outbox WHERE tenant_id=$1)', [tenantId]);
  await pool.query('DELETE FROM outbox WHERE tenant_id=$1', [tenantId]);
  await pool.end();
});

describe('la respuesta autónoma usa el despacho durable (#380)', () => {
  it.each(['whatsapp', 'instagram', 'messenger', 'webchat'] as const)('%s conserva la política de respuesta y el estado real', async channel => {
    const inbound = await withTenant(pool, tenantId, c => receiveInbound(c, { tenantId, channel, phone: '+56944445555', body: 'hola' }));
    const result = await processSuggest(pool, { tenantId, conversationId: inbound.conversation.id, messageId: inbound.message.id, requestId: 'req-copilot-durable' });
    expect(result.autoReplied).toBeDefined();
    const messages = await pool.query("SELECT id, author_kind, delivery_status FROM messages WHERE conversation_id=$1 AND direction='out'", [inbound.conversation.id]);
    expect(messages.rows).toEqual([{ id: result.autoReplied, author_kind: 'agent', delivery_status: channel === 'webchat' ? 'sent' : 'queued' }]);
    const requests = await pool.query("SELECT payload, request_id FROM outbox WHERE tenant_id=$1 AND name='message.delivery_requested' AND payload->>'messageId'=$2", [tenantId, result.autoReplied]);
    expect(requests.rows).toEqual(channel === 'webchat' ? [] : [{ payload: { messageId: result.autoReplied, policy: 'reply' }, request_id: 'req-copilot-durable' }]);
  });
});
