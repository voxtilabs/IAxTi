import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// Camino completo del #7: JWT ES256 verificado contra JWKS (aquí uno local,
// mismo mecanismo que el remoto de Supabase) + rol real desde user_roles.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const adminUser = randomUUID();
const extraño = randomUUID();
const platformAdmin = randomUUID();

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL; // apiPool (GET /me)
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-jwt') RETURNING id");
  tenant = t.rows[0].id;

  // ADMIN real vía flujo de invitación del módulo identity.
  const inv = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'dueña@negocio.cl', roleName: 'ADMIN' }),
  );
  await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: adminUser }));

  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256' }] });
  firmar = (sub) =>
    new SignJWT({ email: 'x@y.cl' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setExpirationTime('5m')
      .sign(privateKey);

  await admin.query('INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [platformAdmin]);

  app = await createApp({
    jwtVerify: async (token) => {
      const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
      return { userId: payload.sub as string };
    },
    resolveRole: dbRoleResolver(admin),
    resolvePlatformAdmin: async (userId) => {
      const r = await admin.query('SELECT 1 FROM platform_admins WHERE user_id = $1', [userId]);
      return (r.rowCount ?? 0) > 0;
    },
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await admin.query('DELETE FROM platform_admins WHERE user_id = $1', [platformAdmin]);
  await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM invitations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

const url = () => `${base}/v1/demo/protegido`;

describe('autenticación por JWT (Supabase, camino real)', () => {
  it('platform.tenants: solo para administradores de plataforma (SPEC §22)', async () => {
    const url = `${base}/v1/platform/tenants`;
    const noPlataforma = await fetch(url, {
      headers: { Authorization: `Bearer ${await firmar(adminUser)}` },
    });
    expect(noPlataforma.status).toBe(403); // ADMIN de tenant ≠ SUPERADMIN

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await firmar(platformAdmin)}` },
    });
    expect(res.status).toBe(200);
    const lista = await res.json();
    expect(lista.some((t: { name: string }) => t.name === 'test-jwt')).toBe(true);
  });

  it('GET /v1/me devuelve el usuario y sus negocios; sin sesión, 401', async () => {
    const res = await fetch(`${base}/v1/me`, {
      headers: { Authorization: `Bearer ${await firmar(adminUser)}` },
    });
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me.userId).toBe(adminUser);
    expect(me.tenants).toEqual([
      { tenantId: tenant, tenantName: 'test-jwt', roleName: 'ADMIN' },
    ]);

    expect((await fetch(`${base}/v1/me`)).status).toBe(401);
  });

  it('Bearer válido + membresía ADMIN: 200', async () => {
    const res = await fetch(url(), {
      headers: { Authorization: `Bearer ${await firmar(adminUser)}`, 'X-Tenant-Id': tenant },
    });
    expect(res.status).toBe(200);
  });

  it('token con firma inválida: 401 TOKEN_INVALID', async () => {
    const res = await fetch(url(), {
      headers: { Authorization: 'Bearer no.es.un-jwt', 'X-Tenant-Id': tenant },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('TOKEN_INVALID');
  });

  it('sin X-Tenant-Id: 401 TENANT_REQUIRED', async () => {
    const res = await fetch(url(), {
      headers: { Authorization: `Bearer ${await firmar(adminUser)}` },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('TENANT_REQUIRED');
  });

  it('usuario sin membresía en el tenant: 403 NOT_A_MEMBER', async () => {
    const res = await fetch(url(), {
      headers: { Authorization: `Bearer ${await firmar(extraño)}`, 'X-Tenant-Id': tenant },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_A_MEMBER');
  });
});
