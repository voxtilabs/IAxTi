import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { incrementUsage } from '@iaxti/module-organizations';
import { bump } from '@iaxti/module-analytics';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// El dashboard de consumo (#26): el tenant ve SU uso contra SU cuota;
// el SuperAdmin ve todos contra sus topes. UsageMeter como fuente.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID(); // ADMIN
const vendedor = randomUUID(); // USER
const superadmin = randomUUID();

async function pedir(quien: string, path: string): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
    headers: {
      Authorization: `Bearer ${await firmar(quien)}`,
      'X-Tenant-Id': tenant,
    },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan) VALUES ('test-api-usage', 'base') RETURNING id",
  );
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'dueña@uso.cl', 'ADMIN'],
    [vendedor, 'vende@uso.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }
  // Consumo YA volcado (lo que haría el flush #26).
  await withTenant(admin, tenant, async (c) => {
    await incrementUsage(c, tenant, 'api_requests', 42);
    await bump(c, { tenantId: tenant, metric: 'api_requests' as never, value: 42 });
    await bump(c, { tenantId: tenant, metric: 'api_ep:GET /v1/contacts' as never, value: 30 });
    await bump(c, { tenantId: tenant, metric: 'api_ep:GET /v1/deals' as never, value: 12 });
  });

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
    resolvePlatformAdmin: async (userId) => userId === superadmin,
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  for (const tabla of ['daily_metrics', 'usage_meters', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('/v1/api-usage (#26)', () => {
  it('el dueño ve su consumo contra la cuota, con evolución y top endpoints', async () => {
    expect((await pedir(vendedor, '/api-usage')).status).toBe(403); // apikeys.manage

    const res = await pedir(duena, '/api-usage');
    expect(res.status).toBe(200);
    const uso = await res.json();
    expect(uso.used).toBe(42);
    expect(uso.limit).toBe(10000); // plan base
    expect(uso.porDia[0].n).toBe(42);
    expect(uso.topEndpoints[0]).toMatchObject({ endpoint: 'GET /v1/contacts', n: 30 });
  });

  it('el SuperAdmin ve todos los tenants contra sus topes', async () => {
    expect((await pedir(duena, '/platform/api-usage')).status).toBe(403);

    const res = await pedir(superadmin, '/platform/api-usage');
    expect(res.status).toBe(200);
    const filas = await res.json();
    const mio = filas.find((f: { id: string }) => f.id === tenant);
    expect(mio).toMatchObject({ used: 42, limit: 10000, plan: 'base' });
  });
});
