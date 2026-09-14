import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { bump } from '@iaxti/module-analytics';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// La API de reportes (#66): sin read_all cada uno ve SOLO sus números.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const supervisora = randomUUID(); // SUPERVISOR
const vendedor = randomUUID(); // USER

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
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-analytics-api') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [supervisora, 'sup@rep.cl', 'SUPERVISOR'],
    [vendedor, 'vende@rep.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }
  // Total del tenant: 5 resueltas; del vendedor: 2 (bump escribe ambas filas).
  await withTenant(admin, tenant, (c) => bump(c, { tenantId: tenant, metric: 'resueltas', value: 3 }));
  await withTenant(admin, tenant, (c) =>
    bump(c, { tenantId: tenant, metric: 'resueltas', value: 2, ownerId: vendedor }),
  );

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
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  for (const tabla of ['daily_metrics', 'response_samples', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('/v1/analytics/dashboard (#66)', () => {
  it('el USER ve SOLO sus números; la SUPERVISORA (read_all) el total', async () => {
    const propio = await (await pedir(vendedor, '/analytics/dashboard')).json();
    expect(propio.metrics.resueltas).toBe(2);

    const todo = await (await pedir(supervisora, '/analytics/dashboard')).json();
    expect(todo.metrics.resueltas).toBe(5);
    expect(todo.definiciones.resueltas).toContain('resueltas');

    // Pedir los números de un colega sin read_all: siempre los propios.
    const espiando = await (
      await pedir(vendedor, `/analytics/dashboard?ownerId=${supervisora}`)
    ).json();
    expect(espiando.metrics.resueltas).toBe(2);
  });

  it('rango inválido responde 400 con voz clara', async () => {
    const res = await pedir(supervisora, '/analytics/dashboard?from=2026-09-14&to=2026-01-01');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });
});
