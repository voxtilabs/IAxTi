import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import { ModuleRegistry, OutboxDispatcher } from '@iaxti/core';
import { analyticsConsumers } from '@iaxti/module-analytics';

const role = `analytics_outbox_${randomUUID().replaceAll('-', '')}`;
let owner: Pool;
let app: Pool;
const tenants: string[] = [];
const ids: number[] = [];

beforeAll(async () => {
  owner = createPool();
  await runMigrations(owner);
  await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOSUPERUSER NOBYPASSRLS`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await owner.query(`GRANT SELECT ON tenants TO ${role}`);
  await owner.query(`GRANT SELECT, UPDATE ON outbox TO ${role}`);
  await owner.query(`GRANT SELECT, INSERT ON processed_events TO ${role}`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE ON daily_metrics TO ${role}`);
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti');
  url.username = role;
  url.password = role;
  app = new Pool({ connectionString: url.toString(), max: 1 });
  expect((await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows)
    .toEqual([{ rolsuper: false, rolbypassrls: false }]);
  for (const amount of [12000, 35000]) {
    const tenantId = (await owner.query("INSERT INTO tenants (name) VALUES ('analytics-outbox-rls') RETURNING id")).rows[0].id;
    tenants.push(tenantId);
    ids.push(Number((await owner.query(`INSERT INTO outbox (name, tenant_id, payload, actor)
      VALUES ('deal.won', $1, $2, 'system') RETURNING id`, [tenantId, { valueClp: amount }])).rows[0].id));
  }
});

afterAll(async () => {
  await app?.end();
  await owner.query('DELETE FROM processed_events WHERE event_id = ANY($1::bigint[])', [ids]);
  await owner.query('DELETE FROM outbox WHERE id = ANY($1::bigint[])', [ids]);
  await owner.query('DELETE FROM daily_metrics WHERE tenant_id = ANY($1::uuid[])', [tenants]);
  await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
  await owner.query(`DROP OWNED BY ${role}`);
  await owner.query(`DROP ROLE ${role}`);
  await owner.end();
});

it('el dispatcher real entrega analytics con RLS y no duplica agregados al reentregar (#922)', async () => {
  // Solo se acota la selección al fixture; handler y SQL son los de producción.
  const scoped = {
    connect: async () => {
      const client = await app.connect();
      return new Proxy(client, {
        get(target, key) {
          if (key === 'query') return (sql: string, values?: unknown[]) => {
            if (sql.includes('FROM outbox') && sql.includes('FOR UPDATE SKIP LOCKED')) {
              return target.query(sql.replace('ORDER BY id', 'AND id = ANY($3::bigint[]) ORDER BY id'), [...values!, ids]);
            }
            return target.query(sql, values);
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
  } as Pool;
  const dispatcher = new OutboxDispatcher(scoped, new ModuleRegistry().load(), analyticsConsumers());
  const metrics = async () => (await owner.query(`SELECT tenant_id, metric, value::int FROM daily_metrics
    WHERE tenant_id = ANY($1::uuid[]) ORDER BY tenant_id, metric`, [tenants])).rows;
  expect(await dispatcher.tick()).toBe(2);
  const first = await metrics();
  for (const [index, tenant] of tenants.entries()) {
    expect(first.filter(row => row.tenant_id === tenant)).toEqual([
      { tenant_id: tenant, metric: 'ganadas', value: 1 },
      { tenant_id: tenant, metric: 'valor_ganado_clp', value: [12000, 35000][index] },
    ]);
  }
  await owner.query('UPDATE outbox SET processed_at = NULL WHERE id = ANY($1::bigint[])', [ids]);
  expect(await dispatcher.tick()).toBe(2);
  expect(await metrics()).toEqual(first);
  expect((await app.query("SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant")).rows)
    .toEqual([{ tenant: null }]);
  expect((await app.query('SELECT tenant_id FROM daily_metrics')).rowCount).toBe(0);
});
