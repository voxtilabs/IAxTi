import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { purgeTenantRetention, receiveInbound } from '@iaxti/module-conversations';
import { createWidget, detachSessionsFromConversations, startSession } from '@iaxti/module-webchat';

const NOW = new Date('2026-01-15T12:00:00Z');
let owner: Pool;
let app: Pool;

beforeAll(async () => {
  owner = createPool();
  await runMigrations(owner);
  await owner.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_retention_test') THEN
      CREATE ROLE iaxti_retention_test LOGIN PASSWORD 'iaxti_retention_test' NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$`);
  await owner.query('GRANT USAGE ON SCHEMA public TO iaxti_retention_test');
  await owner.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO iaxti_retention_test');
  await owner.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO iaxti_retention_test');
  await owner.query(`GRANT DELETE ON conversations, messages, internal_notes, assignments,
    suggestions, agent_conversation_modes, sequence_enrollments, response_samples TO iaxti_retention_test`);
  await owner.query('GRANT UPDATE ON webchat_sessions, tenants, conversations TO iaxti_retention_test');
  await owner.query('GRANT INSERT ON audit_log, outbox TO iaxti_retention_test');
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti');
  url.username = 'iaxti_retention_test';
  url.password = 'iaxti_retention_test';
  app = createPool(url.toString());
  const role = await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
});

afterAll(async () => { await app?.end(); await owner?.end(); });

async function fixture(state = 'resolved') {
  const t = await owner.query("INSERT INTO tenants (name, plan, state) VALUES ('retention-webchat-905', 'base', 'active') RETURNING id");
  const tenantId: string = t.rows[0].id;
  return withTenant(owner, tenantId, async client => {
    const widget = await createWidget(client, { tenantId, allowedDomain: 'prueba.example' });
    const inbound = await receiveInbound(client, {
      tenantId, phone: '+56901010905', channel: 'webchat', channelAccountId: widget.channelAccountId, body: 'hola',
    });
    const conversationId = inbound.conversation.id;
    const session = await startSession(client, { tenantId, widgetId: widget.id });
    await client.query('UPDATE webchat_sessions SET conversation_id = $2 WHERE id = $1', [session.id, conversationId]);
    await client.query('UPDATE conversations SET state = $2, last_message_at = $3 WHERE id = $1',
      [conversationId, state, new Date('2024-11-15T12:00:00Z')]);
    return { tenantId, conversationId, sessionId: session.id, messageId: inbound.message.id };
  });
}

const deps = { detachSessions: detachSessionsFromConversations };

describe('retención y webchat en la misma transacción (#905)', () => {
  it('suelta el FK y purga con RLS, conservando la sesión y los datos del otro tenant', async () => {
    const a = await fixture();
    const b = await fixture();
    const detach = vi.fn(detachSessionsFromConversations);
    const result = await purgeTenantRetention(app, a.tenantId, { detachSessions: detach }, NOW);
    expect(result?.purged).toBe(1);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(detach.mock.calls[0][1]).toEqual({ tenantId: a.tenantId, conversationIds: [a.conversationId] });
    expect((await owner.query('SELECT conversation_id FROM webchat_sessions WHERE id = $1', [a.sessionId])).rows)
      .toEqual([{ conversation_id: null }]);
    expect((await owner.query('SELECT id FROM conversations WHERE id = $1', [a.conversationId])).rowCount).toBe(0);
    expect((await owner.query('SELECT id FROM messages WHERE id = $1', [a.messageId])).rowCount).toBe(0);
    expect((await owner.query('SELECT conversation_id FROM webchat_sessions WHERE id = $1', [b.sessionId])).rows)
      .toEqual([{ conversation_id: b.conversationId }]);
    expect((await owner.query('SELECT id FROM conversations WHERE id = $1', [b.conversationId])).rowCount).toBe(1);
    expect((await owner.query("SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'conversations.retention.purged'", [a.tenantId])).rows)
      .toEqual([expect.objectContaining({ metadata: expect.objectContaining({ purged: 1 }) })]);
  });

  it('si el contrato falla después de soltar el FK, revierte la sesión y no borra conversaciones ni mensajes del lote', async () => {
    const a = await fixture();
    await expect(purgeTenantRetention(app, a.tenantId, {
      detachSessions: async (client, input) => {
        await detachSessionsFromConversations(client, input);
        // El UPDATE ocurrió de verdad antes del error, en el cliente de la purga.
        expect((await client.query('SELECT conversation_id FROM webchat_sessions WHERE id = $1', [a.sessionId])).rows[0].conversation_id).toBeNull();
        throw new Error('fallo después de soltar sesiones');
      },
    }, NOW)).rejects.toThrow('fallo después de soltar sesiones');
    expect((await owner.query('SELECT conversation_id FROM webchat_sessions WHERE id = $1', [a.sessionId])).rows)
      .toEqual([{ conversation_id: a.conversationId }]);
    expect((await owner.query('SELECT id FROM conversations WHERE id = $1', [a.conversationId])).rowCount).toBe(1);
    expect((await owner.query('SELECT id FROM messages WHERE id = $1', [a.messageId])).rowCount).toBe(1);
    expect((await owner.query("SELECT id FROM audit_log WHERE tenant_id = $1 AND action = 'conversations.retention.purged'", [a.tenantId])).rowCount).toBe(0);
    expect((await purgeTenantRetention(app, a.tenantId, deps, NOW))?.purged).toBe(1);
  });

  it('el contrato respeta tenant y lista de conversaciones incluso con ids ajenos', async () => {
    const a = await fixture();
    const b = await fixture();
    await withTenant(app, a.tenantId, async client => {
      await detachSessionsFromConversations(client, { tenantId: a.tenantId, conversationIds: [] });
      await detachSessionsFromConversations(client, { tenantId: a.tenantId, conversationIds: [b.conversationId] });
      await detachSessionsFromConversations(client, { tenantId: b.tenantId, conversationIds: [b.conversationId] });
    });
    const sessions = await owner.query('SELECT conversation_id FROM webchat_sessions WHERE id = ANY($1::uuid[])', [[a.sessionId, b.sessionId]]);
    expect(sessions.rows.map(r => r.conversation_id).sort()).toEqual([a.conversationId, b.conversationId].sort());
  });

  it('no suelta sesiones de conversaciones abiertas aunque sean antiguas', async () => {
    const a = await fixture('open');
    const detach = vi.fn(detachSessionsFromConversations);
    expect(await purgeTenantRetention(app, a.tenantId, { detachSessions: detach }, NOW)).toBeNull();
    expect(detach).not.toHaveBeenCalled();
    expect((await owner.query('SELECT conversation_id FROM webchat_sessions WHERE id = $1', [a.sessionId])).rows)
      .toEqual([{ conversation_id: a.conversationId }]);
  });
});
