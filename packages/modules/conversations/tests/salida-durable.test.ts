import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { retryOutboundDelivery, sendMessage } from '../contract';
import { MAX_ATTEMPTS } from '@iaxti/core';

let pool: Pool;
let app: Pool;
let tenantId: string;
let conversationId: string;
const actor = randomUUID();
const datos = () => ({ tenantId, conversationId, authorKind: 'user' as const, authorId: actor, body: 'contenido privado', requestId: 'req-durable' });
const en = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, tenantId, fn);

beforeAll(async () => {
  pool = createPool(); await runMigrations(pool);
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='iaxti_durable_test') THEN
      CREATE ROLE iaxti_durable_test LOGIN PASSWORD 'iaxti_durable_test' NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$`);
  await pool.query('GRANT USAGE ON SCHEMA public TO iaxti_durable_test');
  await pool.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO iaxti_durable_test');
  await pool.query('GRANT SELECT, INSERT, UPDATE ON conversations, messages, outbox TO iaxti_durable_test');
  await pool.query('GRANT SELECT, INSERT ON audit_log TO iaxti_durable_test');
  const url = new URL(process.env.DATABASE_URL!);
  url.username = 'iaxti_durable_test'; url.password = 'iaxti_durable_test';
  app = createPool(url.toString());
});
beforeEach(async () => {
  tenantId = (await pool.query("INSERT INTO tenants (name) VALUES ('salida-durable') RETURNING id")).rows[0].id;
  const contacto = (await pool.query("INSERT INTO contacts (tenant_id, origin) VALUES ($1, 'manual') RETURNING id", [tenantId])).rows[0].id;
  conversationId = (await pool.query("INSERT INTO conversations (tenant_id, contact_id, channel) VALUES ($1, $2, 'whatsapp') RETURNING id", [tenantId, contacto])).rows[0].id;
});
afterAll(async () => { await app.end(); await pool.end(); });
afterEach(async () => {
  await pool.query('DELETE FROM processed_events WHERE event_id IN (SELECT id FROM outbox WHERE tenant_id=$1)', [tenantId]);
  await pool.query('DELETE FROM outbox WHERE tenant_id=$1', [tenantId]);
});

async function agotado() {
  const m = await en(c => sendMessage(c, { ...datos(), delivery: 'reply' }));
  await pool.query('UPDATE outbox SET attempts=$2, last_error=$3 WHERE tenant_id=$1', [tenantId, MAX_ATTEMPTS, 'Redis no disponible']);
  return m;
}
const recuperar = (messageId: string) => en(c => retryOutboundDelivery(c, {
  tenantId, conversationId, messageId, actor, actorKind: 'user', requestId: 'req-retry',
}));

describe('solicitud durable de salida (#380)', () => {
  it.each(['reply', 'business', 'transactional'] as const)('persiste política %s, identidad y requestId sin contenido en el evento', async delivery => {
    const input = { ...datos(), delivery, actorKind: 'apikey' as const };
    const m = await en(c => sendMessage(c, input));
    const events = await pool.query("SELECT payload, actor, request_id FROM outbox WHERE tenant_id=$1 AND name='message.delivery_requested'", [tenantId]);
    expect(events.rows).toEqual([{ payload: { messageId: m.id, policy: delivery }, actor, request_id: 'req-durable' }]);
    const audit = await pool.query('SELECT actor, actor_kind, action FROM audit_log WHERE tenant_id=$1', [tenantId]);
    expect(audit.rows).toEqual([{ actor, actor_kind: 'apikey', action: 'message.delivery_requested' }]);
    expect(m.deliveryStatus).toBe('queued');
  });

  it('ni el worker ni otro proceso ven la solicitud antes del commit', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const input = { ...datos(), delivery: 'reply' as const };
      await sendMessage(c, input);
      expect((await pool.query('SELECT id FROM outbox WHERE tenant_id=$1', [tenantId])).rowCount).toBe(0);
      await c.query('COMMIT');
      expect((await pool.query("SELECT id FROM outbox WHERE tenant_id=$1 AND name='message.delivery_requested'", [tenantId])).rowCount).toBe(1);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  it('rollback revierte mensaje, solicitud y auditoría', async () => {
    const input = { ...datos(), delivery: 'reply' as const };
    await expect(en(async c => { await sendMessage(c, input); throw new Error('revertir'); })).rejects.toThrow('revertir');
    for (const table of ['messages', 'outbox', 'audit_log']) {
      expect((await pool.query(`SELECT id FROM ${table} WHERE tenant_id=$1`, [tenantId])).rowCount).toBe(0);
    }
  });

  it.each(['webchat', 'simulador'])('%s no solicita un envío externo', async canal => {
    await pool.query('UPDATE conversations SET channel=$2 WHERE id=$1', [conversationId, canal]);
    const input = { ...datos(), delivery: 'reply' as const };
    await en(c => sendMessage(c, input));
    expect((await pool.query('SELECT id FROM outbox WHERE tenant_id=$1', [tenantId])).rowCount).toBe(0);
  });

  it('mantiene compatible el emisor anterior mientras se migra por fases', async () => {
    await en(c => sendMessage(c, datos()));
    expect((await pool.query('SELECT id FROM outbox WHERE tenant_id=$1', [tenantId])).rowCount).toBe(0);
  });

  it('rechaza una política desconocida sin escribir mensaje', async () => {
    const input = { ...datos(), delivery: 'desconocida' as 'reply' };
    await expect(en(c => sendMessage(c, input))).rejects.toThrow(/política de salida/);
    expect((await pool.query('SELECT id FROM messages WHERE tenant_id=$1', [tenantId])).rowCount).toBe(0);
  });

  it('recupera el mismo pedido agotado y audita sin duplicar mensaje ni evento', async () => {
    const m = await agotado();
    await recuperar(m.id.toUpperCase());
    expect((await pool.query('SELECT attempts, last_error, processed_at FROM outbox WHERE tenant_id=$1', [tenantId])).rows)
      .toEqual([{ attempts: 0, last_error: null, processed_at: null }]);
    expect((await pool.query('SELECT id FROM messages WHERE tenant_id=$1', [tenantId])).rows).toEqual([{ id: m.id }]);
    expect((await pool.query("SELECT request_id FROM audit_log WHERE tenant_id=$1 AND action='message.delivery_retried'", [tenantId])).rows)
      .toEqual([{ request_id: 'req-retry' }]);
  });

  it('dos recuperaciones concurrentes solo habilitan y auditan un reintento', async () => {
    const m = await agotado();
    const r = await Promise.allSettled([recuperar(m.id), recuperar(m.id)]);
    expect(r.filter(v => v.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter(v => v.status === 'rejected')).toHaveLength(1);
    expect((await pool.query("SELECT id FROM audit_log WHERE tenant_id=$1 AND action='message.delivery_retried'", [tenantId])).rowCount).toBe(1);
  });

  it.each(['sent', 'delivered', 'read', 'failed'])('no recupera un mensaje %s', async status => {
    const m = await agotado();
    await pool.query('UPDATE messages SET delivery_status=$2 WHERE id=$1', [m.id, status]);
    await expect(recuperar(m.id)).rejects.toThrow(/Solo se recuperan/);
    expect((await pool.query('SELECT attempts FROM outbox WHERE tenant_id=$1', [tenantId])).rows[0].attempts).toBe(MAX_ATTEMPTS);
  });

  it('no reinicia pedidos activos ni mensajes de otra conversación', async () => {
    const m = await en(c => sendMessage(c, { ...datos(), delivery: 'reply' }));
    await expect(recuperar(m.id)).rejects.toThrow(/agotado/);
    await expect(en(c => retryOutboundDelivery(c, {
      tenantId, conversationId: randomUUID(), messageId: m.id, actor, actorKind: 'user',
    }))).rejects.toThrow(/No encontramos/);
  });

  it('el rollback de recuperación conserva el agotamiento y revierte la auditoría', async () => {
    const m = await agotado();
    await expect(en(async c => {
      await retryOutboundDelivery(c, { tenantId, conversationId, messageId: m.id, actor, actorKind: 'user' });
      throw new Error('revertir recuperación');
    })).rejects.toThrow('revertir recuperación');
    expect((await pool.query('SELECT attempts FROM outbox WHERE tenant_id=$1', [tenantId])).rows[0].attempts).toBe(MAX_ATTEMPTS);
    expect((await pool.query("SELECT id FROM audit_log WHERE tenant_id=$1 AND action='message.delivery_retried'", [tenantId])).rowCount).toBe(0);
  });

  it('con RLS real crea y recupera lo propio, sin recuperar pedidos de otro tenant', async () => {
    expect((await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
      .toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const m = await withTenant(app, tenantId, c => sendMessage(c, { ...datos(), delivery: 'reply' }));
    await pool.query('UPDATE outbox SET attempts=$2 WHERE tenant_id=$1', [tenantId, MAX_ATTEMPTS]);
    // El contexto RLS es otro, aunque el caller intente proporcionar el tenant ajeno.
    await expect(withTenant(app, randomUUID(), c => retryOutboundDelivery(c, {
      tenantId, conversationId, messageId: m.id, actor, actorKind: 'user',
    }))).rejects.toThrow(/No encontramos/);
    await withTenant(app, tenantId, c => retryOutboundDelivery(c, {
      tenantId, conversationId, messageId: m.id, actor, actorKind: 'user',
    }));
    expect((await pool.query('SELECT attempts FROM outbox WHERE tenant_id=$1', [tenantId])).rows[0].attempts).toBe(0);
  });
});
