import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// La API del runtime (#47): permisos §23 y el aviso claro sin llaves.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID(); // ADMIN
const supervisora = randomUUID(); // SUPERVISOR
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
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-agents') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'dueña@agents.cl', 'ADMIN'],
    [supervisora, 'sup@agents.cl', 'SUPERVISOR'],
    [vendedor, 'vende@agents.cl', 'USER'],
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
  await admin.query('DELETE FROM agent_executions WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM agents WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM invitations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

describe('/v1/agents (#47)', () => {
  it('configurar es del ADMIN (§23); el USER ve pero no crea', async () => {
    const negado = await pedir(vendedor, '/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Sofía' }),
    });
    expect(negado.status).toBe(403);

    const creado = await pedir(duena, '/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Sofía', fallbackSystemPrompt: 'Eres Sofía.' }),
    });
    expect(creado.status).toBe(201);
    const agente = await creado.json();
    expect(agente.provider).toBe('google'); // default de la spec

    const lista = await (await pedir(vendedor, '/agents')).json();
    expect(lista.map((a: { name: string }) => a.name)).toContain('Sofía');
  });

  it('cambiar de modelo es un PUT, no un deploy; proveedor pirata 400', async () => {
    const [agente] = await (await pedir(duena, '/agents')).json();
    const editado = await pedir(duena, `/agents/${agente.id}`, {
      method: 'PUT',
      body: JSON.stringify({ provider: 'glm', model: 'glm-4.6' }),
    });
    expect(editado.status).toBe(200);
    expect((await editado.json()).model).toBe('glm-4.6');

    const pirata = await pedir(duena, `/agents/${agente.id}`, {
      method: 'PUT',
      body: JSON.stringify({ provider: 'pirata' }),
    });
    expect(pirata.status).toBe(400);
  });

  it('sin llave del proveedor, correr avisa claro (503) — jamás tier gratis', async () => {
    const [agente] = await (await pedir(duena, '/agents')).json();
    const res = await pedir(vendedor, `/agents/${agente.id}/run`, {
      method: 'POST',
      body: JSON.stringify({ task: 'sugerir', prompt: 'hola' }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('el consumo es de supervisión (§23): USER 403, SUPERVISORA 200', async () => {
    expect((await pedir(vendedor, '/agents/executions')).status).toBe(403);
    const res = await pedir(supervisora, '/agents/executions');
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
