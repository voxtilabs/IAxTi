import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import { grantPlatformAdmin, isPlatformAdmin, listTenants } from '../application/platform';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
const uid = randomUUID();

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
});

afterAll(async () => {
  await admin.query('DELETE FROM platform_admins WHERE user_id = $1', [uid]);
  await admin.end();
});

describe('platform', () => {
  it('grant/isPlatformAdmin: cross-tenant, idempotente', async () => {
    const c = await admin.connect();
    try {
      expect(await isPlatformAdmin(c, uid)).toBe(false);
      await grantPlatformAdmin(c, uid);
      await grantPlatformAdmin(c, uid);
      expect(await isPlatformAdmin(c, uid)).toBe(true);
    } finally {
      c.release();
    }
  });

  it('listTenants entrega nombre, plan, estado y fecha', async () => {
    const c = await admin.connect();
    try {
      const t = await c.query("INSERT INTO tenants (name) VALUES ('plat-test') RETURNING id");
      const lista = await listTenants(c);
      const mio = lista.find((x) => x.id === t.rows[0].id);
      expect(mio).toMatchObject({ name: 'plat-test', plan: 'base', state: 'trial' });
      expect(mio?.createdAt).toBeInstanceOf(Date);
      await c.query('DELETE FROM tenants WHERE id = $1', [t.rows[0].id]);
    } finally {
      c.release();
    }
  });
});
