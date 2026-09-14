import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { resolveApiKey } from '@iaxti/module-authorization';
import { apiRequestsLimit } from '@iaxti/module-organizations';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// La cuota mensual de la API (#25): tope del plan + override del
// SuperAdmin, 429 con cabeceras, y los umbrales 80/100 UNA vez.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let token: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID(); // ADMIN
const superadmin = randomUUID();

async function pedir(quien: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await firmar(quien)}`,
      'X-Tenant-Id': tenant,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

function conKey(path: string): Promise<Response> {
  return fetch(`${base}/v1${path}`, { headers: { 'X-Api-Key': token } });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan) VALUES ('test-api-quota', 'base') RETURNING id",
  );
  tenant = t.rows[0].id;
  const inv = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'dueña@quota.cl', roleName: 'ADMIN' }),
  );
  await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: duena }));

  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256' }] });
  firmar = (sub) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setExpirationTime('5m')
      .sign(privateKey);
  app = await createApp({
    jwtVerify: async (token) => {
      const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
      return { userId: payload.sub as string };
    },
    resolveRole: dbRoleResolver(admin),
    resolveApiKey: (t) => resolveApiKey(admin, t),
    resolvePlatformAdmin: async (userId) => userId === superadmin,
  });
  await app.listen(0);
  base = await app.getUrl();

  const creada = await pedir(duena, '/apikeys', {
    method: 'POST',
    body: JSON.stringify({ name: 'Cuota', scopes: ['crm.contacts.read'] }),
  });
  ({ token } = await creada.json());
});

afterAll(async () => {
  await app.close();
  for (const tabla of ['api_keys', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('cuota mensual de la API (#25)', () => {
  it('el tope sale del plan; el override del SuperAdmin manda y vuelve al plan con null', async () => {
    expect(await withTenant(admin, tenant, (c) => apiRequestsLimit(c, tenant))).toBe(10000); // plan base

    const negado = await pedir(duena, `/platform/tenants/${tenant}/api-quota`, {
      method: 'PUT',
      body: JSON.stringify({ requestsMonth: 3 }),
    });
    expect(negado.status).toBe(403); // ADMIN de tenant NO es SUPERADMIN

    const ok = await pedir(superadmin, `/platform/tenants/${tenant}/api-quota`, {
      method: 'PUT',
      body: JSON.stringify({ requestsMonth: 3 }),
    });
    expect(ok.status).toBe(200);
    expect(await withTenant(admin, tenant, (c) => apiRequestsLimit(c, tenant))).toBe(3);
  });

  it('la key corta en el tope con 429, cabeceras y umbrales UNA vez', async () => {
    // Tope 3 (el override del test anterior). El guard cachea 60 s el
    // tope, pero este tenant no se había consultado aún: toma el 3.
    const r1 = await conKey('/contacts');
    expect(r1.status).toBe(200);
    expect(r1.headers.get('x-api-quota-limit')).toBe('3');
    const r2 = await conKey('/contacts');
    expect(Number(r2.headers.get('x-api-quota-remaining'))).toBe(1);
    const r3 = await conKey('/contacts');
    expect(r3.status).toBe(200);

    const r4 = await conKey('/contacts');
    expect(r4.status).toBe(429);
    expect((await r4.json()).code).toBe('QUOTA_EXCEEDED');
    expect(Number(r4.headers.get('retry-after'))).toBeGreaterThan(0);

    // Umbrales 80 y 100: un evento por ciclo, aunque sigan llegando requests.
    await conKey('/contacts');
    const eventos = await admin.query(
      `SELECT payload FROM outbox WHERE tenant_id = $1 AND name = 'usage.threshold_reached'
        AND payload->>'metric' = 'api_requests' ORDER BY id`,
      [tenant],
    );
    expect(eventos.rows.map((e) => Number(e.payload.level))).toEqual([80, 100]);
  });

  it('las requests con sesión humana NO consumen la cuota de la API', async () => {
    const res = await pedir(duena, '/apikeys');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-api-quota-limit')).toBeNull();
  });
});
