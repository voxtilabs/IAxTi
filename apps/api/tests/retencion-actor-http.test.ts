import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { urlDeLaApp } from './url-de-la-app';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { scheduleRetentionNotice, setRetentionOverride } from '@iaxti/module-conversations';
import { createApp } from '../src/main';
import { usarPool } from '../src/db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const rol = `retencion_${randomUUID().replaceAll('-', '')}`;
const userId = randomUUID();
const keyId = randomUUID();
let admin: Pool;
let safe: Pool;
let app: INestApplication;
let base: string;
let tenantId: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  await admin.query(`CREATE ROLE ${rol} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${rol}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${rol}`);
  await admin.query(`REVOKE UPDATE, DELETE ON audit_log FROM ${rol}`);
  await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${rol}`);
  safe = new Pool({ connectionString: ADMIN_URL, options: `-c role=${rol}` });
  expect((await safe.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0])
    .toEqual({ rolsuper: false, rolbypassrls: false });
  tenantId = (await admin.query(
    "INSERT INTO tenants (name, plan, state) VALUES ('actor-retencion-http', 'base', 'active') RETURNING id",
  )).rows[0].id;
  const contact = await admin.query('INSERT INTO contacts (tenant_id, name) VALUES ($1, $2) RETURNING id', [tenantId, 'Persona de prueba']);
  await admin.query(
    `INSERT INTO conversations (tenant_id, contact_id, state, last_message_at)
     VALUES ($1, $2, 'resolved', now() - interval '24 months')`,
    [tenantId, contact.rows[0].id],
  );
  usarPool(safe);
  // Solo la credencial es fixture: guard, scope, ruta, contratos, RLS y audit son reales.
  app = await createApp({
    resolveApiKey: async (token) => ['retencion-fixture', 'sin-scope-fixture'].includes(token)
      ? { id: keyId, tenantId, scopes: token === 'retencion-fixture' ? ['tenant.settings'] : [] }
      : null,
    jwtVerify: async (token) => ({ userId: token }),
    resolveRole: async (tenant, user) => tenant === tenantId && user === userId ? 'ADMIN' : null,
  });
  await app.listen(0, '127.0.0.1');
  base = urlDeLaApp(app);
});

afterAll(async () => {
  await app?.close();
  usarPool(null);
  await safe?.end();
  await admin.query(`DROP OWNED BY ${rol}`);
  await admin.query(`DROP ROLE ${rol}`);
  await admin.end();
});

async function guardar(headers: Record<string, string>, months: number) {
  return fetch(`${base}/v1/settings/retencion`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ months }),
  });
}

async function rastros() {
  return (await admin.query(
    `SELECT actor, actor_kind, metadata FROM audit_log
      WHERE tenant_id = $1 AND action = 'tenant.retention.updated' ORDER BY id`,
    [tenantId],
  )).rows;
}

describe('la retención atribuye el cambio al actor autorizado (#907)', () => {
  it('API key con tenant.settings conserva apikey en el override y en el aviso de purga', async () => {
    const response = await guardar({ 'X-Api-Key': 'retencion-fixture' }, 6);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ saved: true, purgeNotice: { count: 1 } });
    const audit = await rastros();
    expect(audit).toHaveLength(2);
    expect(audit.map(({ actor, actor_kind }) => ({ actor, actor_kind }))).toEqual([
      { actor: `apikey:${keyId}`, actor_kind: 'apikey' },
      { actor: `apikey:${keyId}`, actor_kind: 'apikey' },
    ]);
    expect(audit[0].metadata).toEqual({ monthsOverride: 6 });
    expect(audit[1].metadata.firstPurgeAfter).toEqual(expect.any(String));
  });

  it('una API key sin scope no cambia retención ni agrega auditoría de cambio', async () => {
    const antes = await rastros();
    const settings = (await admin.query('SELECT settings FROM tenants WHERE id = $1', [tenantId])).rows[0];
    expect((await guardar({ 'X-Api-Key': 'sin-scope-fixture' }, 3)).status).toBe(403);
    expect(await rastros()).toEqual(antes);
    expect((await admin.query('SELECT settings FROM tenants WHERE id = $1', [tenantId])).rows[0]).toEqual(settings);
  });

  it('un usuario sigue siendo user en ambas escrituras de la petición', async () => {
    const response = await guardar({ Authorization: `Bearer ${userId}`, 'X-Tenant-Id': tenantId }, 3);
    expect(response.status).toBe(200);
    expect((await rastros()).slice(-2).map(({ actor, actor_kind }) => ({ actor, actor_kind }))).toEqual([
      { actor: userId, actor_kind: 'user' }, { actor: userId, actor_kind: 'user' },
    ]);
  });

  it('los callers automáticos sin autor explícito mantienen system', async () => {
    await withTenant(safe, tenantId, async (c) => {
      await setRetentionOverride(c, { tenantId, months: 2 });
      await scheduleRetentionNotice(c, tenantId);
    });
    expect((await rastros()).slice(-2).map(({ actor, actor_kind }) => ({ actor, actor_kind }))).toEqual([
      { actor: 'system', actor_kind: 'system' }, { actor: 'system', actor_kind: 'system' },
    ]);
  });
});
