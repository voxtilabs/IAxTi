import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// Ajustes de la bandeja (#38): solo el ADMIN (tenant.settings, matriz §23).
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const dueña = randomUUID();
const vendedor = randomUUID();

async function pedir(quien: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/v1/settings/bandeja`, {
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
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-settings') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [dueña, 'dueña@ajustes.cl', 'ADMIN'],
    [vendedor, 'vende@ajustes.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }

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
  await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM invitations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('GET/PUT /v1/settings/bandeja', () => {
  it('el ADMIN lee los por-defecto de la spec', async () => {
    const res = await pedir(dueña);
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s).toMatchObject({
      assignmentMode: 'manual',
      alertaSinDuenoMinutos: 10,
      slaPrimeraRespuestaMinutos: 30,
    });
    expect(s.horario.zona).toBe('America/Santiago');
  });

  it('guardar cambia el modo y los minutos; lo inválido cae al defecto', async () => {
    const res = await pedir(dueña, {
      method: 'PUT',
      body: JSON.stringify({ assignmentMode: 'round_robin', slaPrimeraRespuestaMinutos: 15, alertaSinDuenoMinutos: -3 }),
    });
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.assignmentMode).toBe('round_robin');
    expect(s.slaPrimeraRespuestaMinutos).toBe(15);
    expect(s.alertaSinDuenoMinutos).toBe(10); // el negativo cayó al defecto

    const releido = await (await pedir(dueña)).json();
    expect(releido.assignmentMode).toBe('round_robin');
    expect(releido.slaPrimeraRespuestaMinutos).toBe(15);
  });

  it('un USER no ve ni edita los ajustes (403)', async () => {
    expect((await pedir(vendedor)).status).toBe(403);
    expect((await pedir(vendedor, { method: 'PUT', body: JSON.stringify({}) })).status).toBe(403);
  });
});
