import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { receiveInbound } from '@iaxti/module-conversations';
import { activeSupportSession, endSupportSession, startSupportSession } from '@iaxti/module-platform';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// Modo soporte (SPEC §22 y §23, issue 219). Lo que se prueba acá no es que
// funcione: es que NO funcione en los cuatro casos en que no debe.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const superadmin = randomUUID();
const curiosa = randomUUID(); // usuaria normal, ajena al tenant
const duena = randomUUID();

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

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan) VALUES ('test-soporte', 'crece') RETURNING id",
  );
  tenant = t.rows[0].id;
  const inv = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'duena@soporte.cl', roleName: 'ADMIN' }),
  );
  await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: duena }));
  await withTenant(admin, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, phone: '+56966660001', channel: 'simulador', body: 'hola' }),
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
    // Solo `superadmin` es admin de plataforma.
    resolvePlatformAdmin: async (userId) => userId === superadmin,
    resolveSupportSession: (tenantId, userId) =>
      activeSupportSession(admin, { tenantId, adminUser: userId }),
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  for (const tabla of ['platform_support_sessions', 'messages', 'conversations', 'contacts', 'user_roles', 'invitations', 'outbox', 'usage_meters']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]).catch(() => {});
  }
  await admin.end();
});

describe('modo soporte (SPEC §22 y §23)', () => {
  it('sin sesión, el SUPERADMIN no entra: NOT_A_MEMBER', async () => {
    const r = await pedir(superadmin, '/conversations');
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('NOT_A_MEMBER');
  });

  it('con sesión viva LEE la bandeja, y queda en el libro del tenant', async () => {
    await startSupportSession(admin, { tenantId: tenant, adminUser: superadmin, hours: 2, reason: 'ticket 12' });
    const r = await pedir(superadmin, '/conversations');
    expect(r.status).toBe(200);

    // El rastro: sin esto el cliente no puede saber quién miró.
    await new Promise((r) => setTimeout(r, 150)); // el audit es best-effort
    const rastro = await admin.query(
      `SELECT actor, actor_kind, action FROM audit_log
        WHERE tenant_id = $1 AND action = 'platform.support.access' ORDER BY id DESC LIMIT 1`,
      [tenant],
    );
    expect(rastro.rows[0]).toMatchObject({ actor: superadmin, actor_kind: 'superadmin' });
  });

  it('aunque la sesión esté viva, NO escribe', async () => {
    // `/deals` existe y pide crm.deals.create: el guard corta antes de que
    // el controlador mire siquiera el cuerpo.
    const r = await pedir(superadmin, '/deals', {
      method: 'POST',
      body: JSON.stringify({ contactId: randomUUID(), title: 'Metido' }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('PERMISSION_DENIED');
  });

  it('una usuaria normal no gana nada con la sesión del soporte abierta', async () => {
    const r = await pedir(curiosa, '/conversations');
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('NOT_A_MEMBER');
  });

  it('cerrada la sesión, se acabó el acceso', async () => {
    await endSupportSession(admin, { tenantId: tenant, adminUser: superadmin });
    const r = await pedir(superadmin, '/conversations');
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('NOT_A_MEMBER');
  });

  it('una sesión VENCIDA tampoco sirve', async () => {
    await startSupportSession(admin, { tenantId: tenant, adminUser: superadmin, hours: 1 });
    await admin.query(
      "UPDATE platform_support_sessions SET ends_at = now() - interval '1 minute' WHERE tenant_id = $1",
      [tenant],
    );
    const r = await pedir(superadmin, '/conversations');
    expect(r.status).toBe(403);
  });

  it('la dueña sigue entrando como siempre', async () => {
    const r = await pedir(duena, '/conversations');
    expect(r.status).toBe(200);
  });
});
