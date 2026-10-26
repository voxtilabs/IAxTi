import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { urlDeLaApp } from './url-de-la-app';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { scheduleRetentionNotice, setRetentionOverride } from '@iaxti/module-conversations';
import { olvidarZonas } from '@iaxti/module-organizations';
import { olvidarEnCache } from '@iaxti/core';
import { createApp } from '../src/main';
import { usarPool, apiRedis } from '../src/db';

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

/**
 * Y las fechas de la retención salen de la zona del NEGOCIO (#1076).
 *
 * `cutoff`, `deferredUntil` y `firstPurgeAt` se le muestran a una persona
 * —«el historial anterior al X se elimina», «se eliminarán a partir del X»—
 * y salían de `toISOString()`, o sea UTC. En Chile eso adelanta el día cada
 * noche a partir de las 21:00, y las dos pantallas que pintan el mismo corte
 * terminaban diciendo días distintos.
 *
 * Se finge solo `Date`: lo único que hay que anclar es el instante desde el
 * que se calcula el corte.
 */
describe('las fechas de la retención, en la zona del negocio (#1076)', () => {
  // 22:10 del 25 en Chile. En UTC ya es el 26.
  const LAS_22_10_EN_CHILE = new Date('2026-10-26T01:10:00.000Z');

  afterEach(async () => {
    vi.useRealTimers();
    await admin.query("UPDATE tenants SET timezone = 'America/Santiago' WHERE id = $1", [tenantId]);
    olvidarZonas();
  });

  async function retencion(): Promise<{ cutoff: string | null; months: number | null }> {
    const res = await fetch(`${base}/v1/settings/retencion`, { headers: { 'X-Api-Key': 'retencion-fixture' } });
    expect(res.status).toBe(200);
    return res.json() as Promise<{ cutoff: string | null; months: number | null }>;
  }

  it('el corte se fecha con el día del negocio y no con el de UTC', async () => {
    await withTenant(safe, tenantId, (c) => setRetentionOverride(c, { tenantId, months: 6 }));
    await admin.query("UPDATE tenants SET timezone = 'America/Santiago' WHERE id = $1", [tenantId]);
    olvidarZonas();
    await olvidarEnCache(apiRedis(), { clave: 'retencion', tenantId });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LAS_22_10_EN_CHILE);

    // Seis meses antes del 25 de octubre chileno: el 25 de abril.
    expect((await retencion()).cutoff).toBe('2026-04-25');
  });

  it('la zona del TENANT manda, y no la del producto ni UTC', async () => {
    // Otro instante, por el mismo motivo que en #1072 y #1074: para un mismo
    // instante existen solo DOS días en el planeta, así que con las 01:10 UTC
    // cualquier zona da el 25 (como Chile) o el 26 (como UTC), y una prueba
    // con Auckland pasaría con el defecto puesto. Al mediodía UTC los tres se
    // separan: UTC el 26, Chile el 26 a las 09:00, Auckland el 27 a la 01:00.
    await withTenant(safe, tenantId, (c) => setRetentionOverride(c, { tenantId, months: 6 }));
    await admin.query("UPDATE tenants SET timezone = 'Pacific/Auckland' WHERE id = $1", [tenantId]);
    olvidarZonas();
    // Y el cache de la ruta, que es de cinco minutos: sin esto la segunda
    // afirmación lee la respuesta de la primera y la prueba mide el cache en
    // vez de la zona. Lo encontró dando 2026-04-25, que era el corte de la
    // prueba anterior.
    await olvidarEnCache(apiRedis(), { clave: 'retencion', tenantId });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));

    const { cutoff } = await retencion();
    expect(cutoff).toBe('2026-04-27');
    // El 26 es lo que dirían UTC y la zona del producto.
    expect(cutoff).not.toBe('2026-04-26');
  });
});

