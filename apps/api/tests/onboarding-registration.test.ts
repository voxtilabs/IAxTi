import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, generateKeyPair, jwtVerify } from 'jose';
import { createPool, estadoRls, runMigrations, withAuthenticatedUser, withTenant } from '@iaxti/db';
import { assignRole } from '@iaxti/module-authorization';
import { createTenant, initialBusinessOf } from '@iaxti/module-organizations';
import { createApp } from '../src/main';
import { usarPool } from '../src/db';
import { dbRoleResolver } from '../src/auth/role-resolver';
import { registrationRoutes } from '../../../packages/sdk/src/registration-routes.generated';

const url = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const role = `test_registration_${randomUUID().replaceAll('-', '')}`;
let owner: Pool;
let safe: Pool;
let app: INestApplication;
let base: string;
let token: (user: string) => Promise<string>;
const body = () => ({ displayName: 'Ana', name: `Registro ${randomUUID()}`, description: 'Vendemos servicios con reserva de hora.', vertical: 'servicios' });
async function register(user: string, data: Record<string, unknown> = body(), headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/onboarding/registro`, {
    method: 'POST', headers: { Authorization: `Bearer ${await token(user)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...headers }, body: JSON.stringify(data),
  });
}
beforeAll(async () => {
  owner = createPool(url);
  await runMigrations(owner);
  await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOSUPERUSER NOBYPASSRLS`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await owner.query(`REVOKE UPDATE, DELETE ON audit_log FROM ${role}`);
  await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  safe = createPool(url.replace(/\/\/[^@]+@/, `//${role}:${role}@`));
  usarPool(safe);
  const keys = await generateKeyPair('ES256');
  token = (user) => new SignJWT({}).setProtectedHeader({ alg: 'ES256' }).setSubject(user)
    .setIssuer('https://registration.test/auth').setExpirationTime('5m').sign(keys.privateKey);
  app = await createApp({
    jwtVerify: async (jwt) => ({ userId: (await jwtVerify(jwt, keys.publicKey, { issuer: 'https://registration.test/auth' })).payload.sub! }),
    resolveRole: dbRoleResolver(safe), resolvePlatformAdmin: async () => false,
  });
  await app.listen(0); base = await app.getUrl();
}, 60_000);
afterAll(async () => {
  await app?.close(); usarPool(null); await safe?.end();
  await owner.query(`DROP OWNED BY ${role}`); await owner.query(`DROP ROLE ${role}`); await owner.end();
});

it('solo JWT: cookies, API key, headers y token inválido no crean un negocio', async () => {
  const attempts: Record<string, string>[] = [{}, { Cookie: 'session=pretendida' }, { 'X-Api-Key': 'iaxti_no_valida' },
    { 'X-User-Id': randomUUID(), 'X-Role': 'ADMIN' }, { Authorization: 'Bearer invalido' }];
  for (const headers of attempts) {
    const result = await fetch(`${base}/v1/onboarding/registro`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body()) });
    expect(result.status).toBe(401);
  }
});

it('valida cuerpo e idempotency-key: no acepta elegir identidad, tenant, rol ni plan', async () => {
  for (const extra of [{ userId: randomUUID() }, { tenantId: randomUUID() }, { role: 'SUPERADMIN' }, { plan: 'equipo' }, { trialDays: 365 }, { description: 'corto' }]) {
    expect((await register(randomUUID(), { ...body(), ...extra })).status).toBe(400);
  }
  expect((await register(randomUUID(), body(), { 'Idempotency-Key': '' })).status).toBe(400);
});

it('ocho POST concurrentes dejan una alta con ADMIN, prueba Crece14d, perfil, auditoría y outbox', async () => {
  const user = randomUUID(); const input = body();
  const responses = await Promise.all(Array.from({ length: 8 }, () => register(user, input, { 'X-User-Id': randomUUID(), 'X-Tenant-Id': randomUUID(), 'X-Role': 'SUPERADMIN' })));
  expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
  const memberships = await Promise.all(responses.map((r) => r.json()));
  const tenant = memberships[0].tenantId;
  expect(memberships).toEqual(Array(8).fill({ tenantId: tenant, tenantName: input.name, roleName: 'ADMIN' }));
  const row = (await owner.query('SELECT *, trial_ends_at - created_at AS trial FROM tenants WHERE id=$1', [tenant])).rows[0];
  expect(row).toMatchObject({ name: input.name, rubro: 'servicios', plan: 'crece', state: 'trial', onboarding_state: 'registered', settings: { businessDescription: input.description } });
  expect(row.trial.days).toBe(14);
  expect((await owner.query('SELECT name FROM user_profiles WHERE user_id=$1', [user])).rows[0].name).toBe('Ana');
  expect((await owner.query('SELECT * FROM user_roles WHERE tenant_id=$1', [tenant])).rows).toHaveLength(1);
  expect((await owner.query("SELECT action FROM audit_log WHERE tenant_id=$1 ORDER BY action", [tenant])).rows.map((r) => r.action)).toEqual(['authorization.role.assign', 'onboarding.register']);
  expect((await owner.query("SELECT * FROM outbox WHERE tenant_id=$1 AND name='tenant.created'", [tenant])).rowCount).toBe(1);
  expect((await owner.query('SELECT * FROM initial_business_registrations WHERE user_id=$1', [user])).rowCount).toBe(1);
  const me = await fetch(`${base}/v1/me`, { headers: { Authorization: `Bearer ${await token(user)}` } });
  expect((await me.json()).tenants).toEqual([memberships[0]]);
  const resume = await fetch(`${base}/v1/onboarding/negocio`, { headers: { Authorization: `Bearer ${await token(user)}`, 'X-Tenant-Id': tenant } });
  expect(await resume.json()).toMatchObject({ name: input.name, description: input.description, vertical: input.vertical, plan: 'crece', state: 'trial' });
});

it('referencia original estable tras otra membresía; no restaura acceso revocado', async () => {
  const user = randomUUID();
  const first = await (await register(user)).json();
  const other = await withTenant(owner, randomUUID(), (c) => createTenant(c, { name: 'AAA otro negocio' }));
  await withTenant(owner, other.id, async (c) => {
    await assignRole(c, { tenantId: other.id, userId: user, actor: user, roleName: 'ADMIN', createIfMissing: true });
  });
  expect(await (await register(user)).json()).toEqual(first);
  await owner.query('DELETE FROM user_roles WHERE tenant_id=$1 AND user_id=$2', [first.tenantId, user]);
  const revoked = await register(user);
  expect(revoked.status).toBe(403);
  expect((await revoked.json()).code).toBe('REGISTRATION_ACCESS_REMOVED');
  expect((await owner.query('SELECT * FROM user_roles WHERE tenant_id=$1 AND user_id=$2', [first.tenantId, user])).rowCount).toBe(0);
});

it('la persona ya invitada conserva su rol y su negocio, sin elevar privilegios', async () => {
  const user = randomUUID(); const admin = randomUUID();
  const first = await (await register(admin)).json();
  await withTenant(owner, first.tenantId, (c) => assignRole(c, { tenantId: first.tenantId, userId: user, actor: admin, roleName: 'USER', createIfMissing: true }));
  expect(await (await register(user)).json()).toEqual({ ...first, roleName: 'USER' });
  expect((await owner.query('SELECT * FROM initial_business_registrations WHERE user_id=$1', [user])).rowCount).toBe(0);
});

it('RLS real: solo referencia propia antes del tenant, cero filas sin contexto y descripción ajena prohibida', async () => {
  const user = randomUUID(); const other = randomUUID();
  const first = await (await register(user)).json();
  expect((await estadoRls(safe)).seSalta).toBe(false);
  expect(await withAuthenticatedUser(safe, user, (c) => initialBusinessOf(c, user))).toBe(first.tenantId);
  expect(await withAuthenticatedUser(safe, other, (c) => initialBusinessOf(c, user))).toBeNull();
  expect((await safe.query('SELECT * FROM initial_business_registrations')).rows).toEqual([]);
  expect((await safe.query('SELECT * FROM user_roles')).rows).toEqual([]);
  expect((await fetch(`${base}/v1/onboarding/negocio`, { headers: { Authorization: `Bearer ${await token(other)}`, 'X-Tenant-Id': first.tenantId } })).status).toBe(403);
});

it('fallo real de auditoría revierte tenant, perfil, membresía, outbox y referencia', async () => {
  const user = randomUUID(); const input = body(); const identifier = `fail_${user.replaceAll('-', '')}`;
  await owner.query(`CREATE FUNCTION ${identifier}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test registration audit failure'; END $$`);
  await owner.query(`CREATE TRIGGER ${identifier} BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action = 'onboarding.register' AND NEW.actor = '${user}') EXECUTE FUNCTION ${identifier}()`);
  try {
    expect((await register(user, input)).status).toBe(500);
    expect((await owner.query('SELECT * FROM tenants WHERE name=$1', [input.name])).rowCount).toBe(0);
    for (const table of ['user_profiles', 'user_roles', 'initial_business_registrations']) {
      expect((await owner.query(`SELECT * FROM ${table} WHERE user_id=$1`, [user])).rowCount).toBe(0);
    }
    expect((await owner.query('SELECT * FROM audit_log WHERE actor=$1', [user])).rowCount).toBe(0);
    expect((await owner.query('SELECT * FROM outbox WHERE actor=$1', [user])).rowCount).toBe(0);
  } finally {
    await owner.query(`DROP TRIGGER ${identifier} ON audit_log`); await owner.query(`DROP FUNCTION ${identifier}()`);
  }
  expect((await register(user, input)).status).toBe(200);
});

it('costos reales registrados se leen durante trial sin crear suscripción ni factura', async () => {
  const user = randomUUID(); const first = await (await register(user)).json();
  await owner.query("INSERT INTO daily_metrics(tenant_id,day,metric,value) VALUES($1,current_date,'costo_meta_usd',1.25)", [first.tenantId]);
  const response = await fetch(`${base}/v1/onboarding/costos`, { headers: { Authorization: `Bearer ${await token(user)}`, 'X-Tenant-Id': first.tenantId } });
  expect(response.status).toBe(200);
  expect((await response.json()).cicloEnCurso).toMatchObject({ metaUsd: 1.25, ia: { usd: 0, clp: 0 } });
  for (const table of ['subscriptions', 'invoices']) expect((await owner.query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [first.tenantId])).rowCount).toBe(0);
});

it('rutas del SDK provienen del OpenAPI real', async () => {
  const { paths } = await (await fetch(`${base}/docs-json`)).json();
  for (const [key, route] of Object.entries(registrationRoutes)) {
    expect(paths[route.path]?.[route.method.toLowerCase()]?.operationId).toBe(key === 'memberships' ? 'MeController_me' : `OnboardingRegistrationController_${key}`);
  }
});
