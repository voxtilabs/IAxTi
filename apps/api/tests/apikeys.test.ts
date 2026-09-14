import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { resolveApiKey } from '@iaxti/module-authorization';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// API keys (#24): self-service del ADMIN, token una sola vez, y la key
// USADA DE VERDAD contra la API — mismos guards, scopes como techo.
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

function conKey(token: string, path: string): Promise<Response> {
  // SIN Bearer y SIN X-Tenant-Id: la key trae su tenant.
  return fetch(`${base}/v1${path}`, { headers: { 'X-Api-Key': token } });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-apikeys') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'dueña@keys.cl', 'ADMIN'],
    [vendedor, 'vende@keys.cl', 'USER'],
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
    resolveApiKey: (token) => resolveApiKey(admin, token),
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  for (const tabla of ['api_keys', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('/v1/apikeys (#24)', () => {
  it('gestionar keys es del ADMIN; el USER ni las ve', async () => {
    expect((await pedir(vendedor, '/apikeys')).status).toBe(403);
    expect((await pedir(duena, '/apikeys')).status).toBe(200);
    const scopes = await (await pedir(duena, '/apikeys/scopes')).json();
    expect(scopes).toContain('crm.contacts.read');
    expect(scopes.every((s: string) => !s.startsWith('platform.'))).toBe(true);
  });

  it('el token se ve UNA vez, el hash queda, y los scopes se validan', async () => {
    const basura = await pedir(duena, '/apikeys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Mala', scopes: ['superpoderes.todo'] }),
    });
    expect(basura.status).toBe(400);

    const res = await pedir(duena, '/apikeys', {
      method: 'POST',
      body: JSON.stringify({ name: 'ERP', scopes: ['crm.contacts.read', 'conversations.read'] }),
    });
    expect(res.status).toBe(201);
    const { token, apiKey } = await res.json();
    expect(token).toMatch(/^iaxti_/);
    expect(JSON.stringify(apiKey)).not.toContain(token); // el token no viaja en el registro

    const fila = await admin.query('SELECT key_hash FROM api_keys WHERE id = $1', [apiKey.id]);
    expect(fila.rows[0].key_hash).not.toContain(token.slice(6, 20)); // solo hash
  });

  it('la key FUNCIONA contra la API con sus scopes como techo, y registra el uso', async () => {
    const [key] = await (await pedir(duena, '/apikeys')).json();
    void key;
    const creada = await pedir(duena, '/apikeys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Lector', scopes: ['crm.contacts.read'] }),
    });
    const { token, apiKey } = await creada.json();

    // Con scope: 200 (sin Bearer, sin X-Tenant-Id — jamás cross-tenant).
    const ok = await conKey(token, '/contacts');
    expect(ok.status).toBe(200);

    // Sin ese scope: 403 con el formato de error único.
    const negado = await conKey(token, '/conversations');
    expect(negado.status).toBe(403);
    expect((await negado.json()).code).toBe('PERMISSION_DENIED');

    // El último uso quedó registrado.
    const fila = await admin.query('SELECT last_used_at FROM api_keys WHERE id = $1', [apiKey.id]);
    expect(fila.rows[0].last_used_at).not.toBeNull();

    // Revocación inmediata: la misma key ahora es 401.
    await pedir(duena, `/apikeys/${apiKey.id}`, { method: 'DELETE' });
    const revocada = await conKey(token, '/contacts');
    expect(revocada.status).toBe(401);
    expect((await revocada.json()).code).toBe('API_KEY_INVALID');
  });

  it('una key vencida responde 401; y el ciclo queda en audit', async () => {
    const creada = await pedir(duena, '/apikeys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Efímera', scopes: ['crm.contacts.read'], expiresAt: '2020-01-01' }),
    });
    const { token } = await creada.json();
    expect((await conKey(token, '/contacts')).status).toBe(401);

    const audit = await admin.query(
      `SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'authorization.apikey%' ORDER BY id`,
      [tenant],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['authorization.apikey.create', 'authorization.apikey.revoke']),
    );
  });
});
