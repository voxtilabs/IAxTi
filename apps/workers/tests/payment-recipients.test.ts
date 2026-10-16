import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { ModuleRegistry, OutboxDispatcher, type EventEnvelope } from '@iaxti/core';
import { confirmPayment } from '@iaxti/module-payments';
import { handleNotifiableEvent, notificationConsumers } from '@iaxti/module-notifications';

let owner: Pool;
let consumer: Pool;

beforeAll(async () => {
  owner = createPool();
  await runMigrations(owner);
  await owner.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_notif_904_test') THEN
      CREATE ROLE iaxti_notif_904_test LOGIN PASSWORD 'iaxti_notif_904_test' NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$`);
  await owner.query('GRANT USAGE ON SCHEMA public TO iaxti_notif_904_test');
  await owner.query('GRANT SELECT ON user_roles, roles, notification_preferences, notifications, push_subscriptions TO iaxti_notif_904_test');
  await owner.query('GRANT INSERT, UPDATE ON notifications TO iaxti_notif_904_test');
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti');
  url.username = 'iaxti_notif_904_test';
  url.password = 'iaxti_notif_904_test';
  consumer = createPool(url.toString());
  const role = await consumer.query("SELECT rolsuper, rolbypassrls, has_table_privilege(current_user, 'conversations', 'SELECT') AS reads_conversations FROM pg_roles WHERE rolname = current_user");
  expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, reads_conversations: false });
});

afterAll(async () => { await consumer?.end(); await owner?.end(); });

async function payment(hasOwner = true) {
  const tenantId = (await owner.query("INSERT INTO tenants (name) VALUES ('payment-owner-904') RETURNING id")).rows[0].id as string;
  const previousOwner = randomUUID();
  const nextOwner = randomUUID();
  const supervisor = randomUUID();
  await owner.query(`INSERT INTO user_roles (tenant_id, user_id, role_id)
    SELECT $1, $2, id FROM roles WHERE tenant_id IS NULL AND name = 'SUPERVISOR'`, [tenantId, supervisor]);
  const contactId = (await owner.query("INSERT INTO contacts (tenant_id, name, origin) VALUES ($1, 'Prueba', 'webchat') RETURNING id", [tenantId])).rows[0].id;
  const conversationId = (await owner.query(`INSERT INTO conversations (tenant_id, contact_id, channel, state, owner_id)
    VALUES ($1, $2, 'webchat', 'open', $3) RETURNING id`, [tenantId, contactId, hasOwner ? previousOwner : null])).rows[0].id;
  const providerId = (await owner.query(`INSERT INTO payment_providers (tenant_id, kind, name, credential_ref, mode, active)
    VALUES ($1, 'simulado', 'Prueba', 'CRED_TEST', 'test', true) RETURNING id`, [tenantId])).rows[0].id;
  const linkId = (await owner.query(`INSERT INTO payment_links (tenant_id, provider_id, contact_id, conversation_id, amount_clp, concept, status, expires_at)
    VALUES ($1, $2, $3, $4, 15000, 'Servicio de prueba', 'sent', now() + interval '1 day') RETURNING id`,
  [tenantId, providerId, contactId, conversationId])).rows[0].id;
  const confirm = () => withTenant(owner, tenantId, client => confirmPayment(client, { tenantId, linkId, status: 'paid' }));
  await confirm();
  const rows = await owner.query("SELECT * FROM outbox WHERE tenant_id = $1 AND name = 'payment.received'", [tenantId]);
  expect(rows.rowCount).toBe(1);
  const row = rows.rows[0];
  const event: EventEnvelope = {
    id: Number(row.id), name: row.name, tenantId, payload: row.payload,
    actor: row.actor, requestId: row.request_id, version: row.version, occurredAt: row.occurred_at,
  };
  return { tenantId, previousOwner, nextOwner, supervisor, conversationId, event, confirm };
}

async function recipients(tenantId: string) {
  return (await owner.query("SELECT user_id, group_count FROM notifications WHERE tenant_id = $1 AND type = 'pago_recibido' ORDER BY user_id", [tenantId])).rows;
}

describe('el destinatario viaja en payment.received (#904)', () => {
  it('un consumo tardío avisa al dueño al confirmar y no al dueño de hoy, sin permiso para leer conversaciones', async () => {
    const p = await payment();
    expect(p.event.payload).toMatchObject({ ownerId: p.previousOwner });
    await owner.query('UPDATE conversations SET owner_id = $2 WHERE id = $1', [p.conversationId, p.nextOwner]);
    await withTenant(consumer, p.tenantId, client => handleNotifiableEvent(p.event, client));
    expect((await recipients(p.tenantId)).map(r => r.user_id).sort()).toEqual([p.previousOwner, p.supervisor].sort());
    // Volver a confirmar no publica otro evento ni cambia la instantánea.
    expect((await p.confirm()).outcome).toBe('already');
    expect((await owner.query("SELECT payload FROM outbox WHERE tenant_id = $1 AND name = 'payment.received'", [p.tenantId])).rows)
      .toEqual([{ payload: p.event.payload }]);
  });

  it.each(['ausente', 'null'] as const)('un evento con ownerId %s degrada a supervisión', async tipo => {
    const p = await payment(false);
    expect(p.event.payload).toMatchObject({ ownerId: null });
    if (tipo === 'ausente') delete (p.event.payload as Record<string, unknown>).ownerId;
    await owner.query('UPDATE conversations SET owner_id = $2 WHERE id = $1', [p.conversationId, p.nextOwner]);
    await withTenant(consumer, p.tenantId, client => handleNotifiableEvent(p.event, client));
    expect((await recipients(p.tenantId)).map(r => r.user_id)).toEqual([p.supervisor]);
  });

  it('el dispatcher conserva la idempotencia sin consumir el backlog de otros casos', async () => {
    const otherTenant = (await owner.query("INSERT INTO tenants (name) VALUES ('backlog-ajeno-904') RETURNING id")).rows[0].id;
    // Más pendientes previos que el antiguo límite global de 10.000. Son de
    // otro caso, y esta prueba no tiene derecho a marcarlos procesados.
    const sentinels = await owner.query(`INSERT INTO outbox (name, tenant_id, payload, actor)
      SELECT 'event.de.otro.caso', $1, '{}'::jsonb, 'system'
      FROM generate_series(1, 10001) RETURNING id`, [otherTenant]);
    try {
      const p = await payment();
      // Se mantiene el dispatcher real (claim, commit y reentrega), pero el
      // cliente del arnés acota su SELECT al único sobre bajo prueba.
      const isolated = {
        connect: async () => {
          const client = await owner.connect();
          return new Proxy(client, {
            get(target, key) {
              if (key === 'query') return (sql: string, values?: unknown[]) => {
                if (sql.includes('FROM outbox') && sql.includes('FOR UPDATE SKIP LOCKED')) {
                  return target.query(sql.replace('ORDER BY id', 'AND id = $3 ORDER BY id'), [...values!, p.event.id]);
                }
                return target.query(sql, values);
              };
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }) as PoolClient;
        },
      } as Pool;
      const dispatcher = new OutboxDispatcher(isolated, new ModuleRegistry().load(),
        notificationConsumers().filter(c => c.event === 'payment.received'));
      await dispatcher.tick();
      const first = await recipients(p.tenantId);
      expect(first.map(r => r.user_id).sort()).toEqual([p.previousOwner, p.supervisor].sort());
      await owner.query('UPDATE conversations SET owner_id = $2 WHERE id = $1', [p.conversationId, p.nextOwner]);
      await owner.query('UPDATE outbox SET processed_at = NULL WHERE id = $1', [p.event.id]);
      await dispatcher.tick();
      expect(await recipients(p.tenantId)).toEqual(first);
      const untouched = await owner.query(`SELECT count(*)::int AS n FROM outbox
        WHERE tenant_id = $1 AND processed_at IS NULL AND attempts = 0`, [otherTenant]);
      expect(untouched.rows[0].n).toBe(sentinels.rowCount);
    } finally {
      await owner.query('DELETE FROM outbox WHERE tenant_id = $1', [otherTenant]);
      await owner.query('DELETE FROM tenants WHERE id = $1', [otherTenant]);
    }
  });
});
