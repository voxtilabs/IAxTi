import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// La API de webhooks salientes (#76): gestionar es del ADMIN, el catálogo
// sale de los manifiestos, y el panel muestra las entregas.
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
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-webhooks-api') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'dueña@wh.cl', 'ADMIN'],
    [vendedor, 'vende@wh.cl', 'USER'],
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
  for (const tabla of ['webhook_deliveries', 'webhook_endpoints', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('/v1/webhooks-salientes (#76)', () => {
  it('gestionar es del ADMIN; el catálogo sale de los manifiestos', async () => {
    expect((await pedir(vendedor, '/webhooks-salientes')).status).toBe(403);

    const eventos = await (await pedir(duena, '/webhooks-salientes/eventos')).json();
    expect(eventos).toContain('deal.won');
    expect(eventos).toContain('payment.received');
    expect(eventos).toContain('conversation.created');
  });

  it('crear valida catálogo, entrega el secreto whsec_ y rota', async () => {
    const pirata = await pedir(duena, '/webhooks-salientes', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://cliente.cl/h', events: ['meteorito.cayo'] }),
    });
    expect(pirata.status).toBe(400);

    const ok = await pedir(duena, '/webhooks-salientes', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://cliente.cl/h', events: ['deal.won'] }),
    });
    expect(ok.status).toBe(201);
    const wh = await ok.json();
    expect(wh.secret).toMatch(/^whsec_/);

    const rotado = await (
      await pedir(duena, `/webhooks-salientes/${wh.id}/rotate`, { method: 'POST' })
    ).json();
    expect(rotado.secret).not.toBe(wh.secret);

    expect((await pedir(duena, '/webhooks-salientes/entregas')).status).toBe(200);
  });
});
