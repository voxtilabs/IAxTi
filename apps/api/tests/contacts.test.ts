import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { changeConversationState, receiveInbound } from '@iaxti/module-conversations';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// La ficha (#32): contacto + oportunidades + actividades, y la historia
// completa de conversaciones (resueltas incluidas) vía ?contactId.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let contacto: string;
let firmar: (sub: string) => Promise<string>;
const vendedor = randomUUID();

async function pedir(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await firmar(vendedor)}`,
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
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-ficha') RETURNING id");
  tenant = t.rows[0].id;
  const inv = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'vende@ficha.cl', roleName: 'USER' }),
  );
  await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: vendedor }));

  // Una conversación resuelta y una viva del mismo contacto.
  const a = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, phone: '+56980000009', channel: 'simulador', body: 'hola' }),
  );
  contacto = a.contact.id;
  await withTenant(admin, tenant, (c) =>
    changeConversationState(c, { tenantId: tenant, conversationId: a.conversation.id, state: 'resolved' }),
  );
  await admin.query('UPDATE conversations SET archived_at = now() WHERE id = $1', [a.conversation.id]);
  await withTenant(admin, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, phone: '+56980000009', channel: 'simulador', body: 'volví' }),
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
    resolveApiKey: async (token) => token === 'test-voxia-service-key'
      ? { id: 'service-key', tenantId: tenant, scopes: ['crm.activities.manage'] }
      : null,
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await admin.query('DELETE FROM activities WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM invitations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('GET /v1/contacts/:id y actividades', () => {
  it('la API key crea una actividad sin tratar su identidad como UUID de usuario', async () => {
    const res = await fetch(`${base}/v1/contacts/${contacto}/activities`, {
      method: 'POST',
      headers: { 'X-Api-Key': 'test-voxia-service-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'llamada', title: 'VOXIA · seguimiento', body: 'Llamada finalizada.' }),
    });
    expect(res.status).toBe(201);
    const actividad = await res.json();
    expect(actividad.ownerId).toBeNull();
    expect(actividad.contactId).toBe(contacto);
    const stored = await admin.query('SELECT tenant_id, owner_id FROM activities WHERE id = $1', [actividad.id]);
    expect(stored.rows[0]).toEqual({ tenant_id: tenant, owner_id: null });
  });

  it('la ficha trae contacto, oportunidades y actividades; inexistente 404', async () => {
    const res = await pedir(`/contacts/${contacto}`);
    expect(res.status).toBe(200);
    const ficha = await res.json();
    expect(ficha.contact.phone).toBe('+56980000009');
    expect(ficha.deals).toEqual([]);
    expect((await pedir(`/contacts/${randomUUID()}`)).status).toBe(404);
  });

  it('el USER crea actividades (crm.activities.manage §23) y las completa', async () => {
    const malo = await pedir(`/contacts/${contacto}/activities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'brujería', title: 'x' }),
    });
    expect(malo.status).toBe(400);

    const res = await pedir(`/contacts/${contacto}/activities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'llamada', title: 'Llamarla mañana', dueAt: new Date().toISOString() }),
    });
    expect(res.status).toBe(201);
    const actividad = await res.json();
    expect(actividad.ownerId).toBe(vendedor);

    const done = await pedir(`/contacts/activities/${actividad.id}/done`, { method: 'POST' });
    expect(done.status).toBe(201);
    expect((await done.json()).doneAt).not.toBeNull();
  });

  it('?contactId trae la historia COMPLETA: resueltas y archivadas incluidas', async () => {
    const res = await pedir(`/conversations?contactId=${contacto}`);
    expect(res.status).toBe(200);
    const { items } = await res.json();
    expect(items).toHaveLength(2);
    const estados = items.map((i: { state: string }) => i.state).sort();
    expect(estados).toEqual(['new', 'resolved']);
  });
});
