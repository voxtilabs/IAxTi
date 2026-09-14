import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import IORedis from 'ioredis';
import { createPool, runMigrations } from '@iaxti/db';
import { redisConnection } from '@iaxti/core';
import { flushApiUsage } from '../src/api-usage';

// El volcado del consumo de API (#26): Redis → usage_meters +
// daily_metrics, sin contar dos veces.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let redis: IORedis;
let tenant: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  redis = redisConnection();
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('api-usage-test') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  for (const tabla of ['daily_metrics', 'usage_meters', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
  redis.disconnect();
});

describe('flush del consumo de API (#26)', () => {
  it('vuelca por día y por endpoint, y la segunda pasada no duplica', async () => {
    const dia = new Date().toISOString().slice(0, 10);
    await redis.set(`apiq:d:${tenant}:${dia}`, '7');
    await redis.set(`apiq:e:${tenant}:${dia}:GET /v1/contacts`, '5');
    await redis.set(`apiq:e:${tenant}:${dia}:GET /v1/deals/:id`, '2');

    const n = await flushApiUsage(admin, redis);
    expect(n).toBeGreaterThanOrEqual(3);

    const meter = await admin.query(
      `SELECT value::int AS v FROM usage_meters WHERE tenant_id = $1 AND metric = 'api_requests'`,
      [tenant],
    );
    expect(meter.rows[0].v).toBe(7);

    const dm = await admin.query(
      `SELECT metric, value::int AS v FROM daily_metrics WHERE tenant_id = $1 ORDER BY metric`,
      [tenant],
    );
    const porMetric = Object.fromEntries(dm.rows.map((r) => [r.metric, r.v]));
    expect(porMetric.api_requests).toBe(7);
    expect(porMetric['api_ep:GET /v1/contacts']).toBe(5);
    expect(porMetric['api_ep:GET /v1/deals/:id']).toBe(2); // la ruta con ':' sobrevive

    // GETDEL: la segunda pasada no encuentra nada del tenant.
    await flushApiUsage(admin, redis);
    const meter2 = await admin.query(
      `SELECT value::int AS v FROM usage_meters WHERE tenant_id = $1 AND metric = 'api_requests'`,
      [tenant],
    );
    expect(meter2.rows[0].v).toBe(7); // sin duplicar
  });
});
