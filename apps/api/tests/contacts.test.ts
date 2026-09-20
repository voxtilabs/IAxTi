import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { changeConversationState, receiveInbound } from '@iaxti/module-conversations';
import { createContact, createDeal, createPipeline } from '@iaxti/module-crm';
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
let ajeno: string;
let contactoAjeno: string;
let trato: string;
let tratoOtroContacto: string;
let tratoAjeno: string;
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
  ajeno = (await admin.query("INSERT INTO tenants (name) VALUES ('test-ficha-ajeno') RETURNING id")).rows[0].id;
  const otro = await withTenant(admin, tenant, (c) => createContact(c, { tenantId: tenant, name: 'Otro', phone: '+56980000010' }));
  contactoAjeno = (await withTenant(admin, ajeno, (c) => createContact(c, { tenantId: ajeno, name: 'Ajeno', phone: '+56980000009' }))).id;
  for (const [negocio, persona, guardar] of [
    [tenant, contacto, (id: string) => { trato = id; }],
    [tenant, otro.id, (id: string) => { tratoOtroContacto = id; }],
    [ajeno, contactoAjeno, (id: string) => { tratoAjeno = id; }],
  ] as const) {
    const pipeline = await withTenant(admin, negocio, (c) => createPipeline(c, {
      tenantId: negocio, name: `Ventas ${persona}`, stages: [
        { name: 'Nuevo', type: 'open' }, { name: 'Ganado', type: 'won' }, { name: 'Perdido', type: 'lost' },
      ],
    }));
    guardar((await withTenant(admin, negocio, (c) => createDeal(c, {
      tenantId: negocio, contactId: persona, pipelineId: pipeline.pipeline.id, title: 'Cotización',
    }))).id);
  }
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
    resolveApiKey: async (token) => ['test-voxia-service-key', 'test-read-only-key'].includes(token)
      ? { id: 'service-key', tenantId: tenant, scopes: token === 'test-voxia-service-key' ? ['crm.activities.manage'] : ['crm.contacts.read'] }
      : null,
  });
  await app.listen(0);
  base = await app.getUrl();
});

it('listas: un cursor inválido responde 400 y el orden viaja a la API', async () => {
  for (const path of ['/contacts?cursor=invalido', '/deals?cursor=invalido', '/contacts?sort=desconocido', '/deals?order=desconocido']) {
    const response = await pedir(path);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID_LIST_QUERY');
  }
  const response = await pedir('/contacts?sort=name&order=asc&limit=1');
  expect(response.status).toBe(200);
  expect((await response.json()).nextCursor).toBeTruthy();
});

it('etiquetar en lote exige permiso y conserva el tenant y la idempotencia', async () => {
  const tag = (await admin.query("INSERT INTO tags(tenant_id,name) VALUES ($1,'Revisión de tabla') RETURNING id", [tenant])).rows[0].id;
  const body = JSON.stringify({ contactIds: [contacto], tagId: tag });
  const denied = await fetch(`${base}/v1/tags/contactos/agregar`, { method: 'POST', headers: { 'X-Api-Key': 'test-read-only-key', 'Content-Type': 'application/json' }, body });
  expect(denied.status).toBe(403);
  const first = await pedir('/tags/contactos/agregar', { method: 'POST', body });
  expect(first.status).toBe(201);
  expect((await first.json()).changed).toBe(1);
  const again = await pedir('/tags/contactos/agregar', { method: 'POST', body });
  expect((await again.json()).changed).toBe(0);
  const foreign = await pedir('/tags/contactos/agregar', { method: 'POST', body: JSON.stringify({ contactIds: [contactoAjeno], tagId: tag }) });
  expect(foreign.status).toBe(400);
});

afterAll(async () => {
  await app.close();
  await admin.query('DELETE FROM activities WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM deal_stage_history WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM deals WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contact_tags WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tags WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM invitations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  // La auditoría es append-only: el tenant se conserva en esta base desechable.
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
    expect(ficha.deals.map((d: { id: string }) => d.id)).toEqual([trato]);
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

async function actividadApi(contactId: string, body: object, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/contacts/${contactId}/activities`, {
    method: 'POST',
    headers: { 'X-Api-Key': 'test-voxia-service-key', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'llamada', title: 'Seguimiento', ...body }),
  });
}

describe('actividades con API key: aislamiento, atribución e idempotencia (#346)', () => {
  it('rechaza contactos de otro tenant o inexistentes sin escribir', async () => {
    for (const id of [contactoAjeno, randomUUID()]) {
      const res = await actividadApi(id, {});
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'CONTACT_NOT_FOUND', requestId: expect.any(String), details: [] });
    }
    expect((await admin.query('SELECT 1 FROM activities WHERE tenant_id = $1 AND contact_id = $2', [tenant, contactoAjeno])).rowCount).toBe(0);
  });

  it('la oportunidad debe pertenecer al contacto y al mismo tenant', async () => {
    for (const dealId of [tratoOtroContacto, tratoAjeno, randomUUID()]) {
      const res = await actividadApi(contacto, { dealId });
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('DEAL_NOT_FOUND');
    }
  });

  it('una llamada repetida devuelve la misma actividad y una sola auditoría de la API key', async () => {
    const requestId = `req-${randomUUID()}`;
    const headers = { 'Idempotency-Key': randomUUID(), 'X-Request-Id': requestId };
    const primera = await actividadApi(contacto, { dealId: trato }, headers);
    expect(primera.status).toBe(201);
    const uno = await primera.json();
    const segunda = await actividadApi(contacto, { dealId: trato }, headers);
    expect(segunda.status).toBe(201);
    expect(segunda.headers.get('Idempotent-Replay')).toBe('true');
    expect(await segunda.json()).toEqual(uno);
    expect(uno).toMatchObject({ ownerId: null, contactId: contacto, dealId: trato });
    const audit = await admin.query('SELECT actor, actor_kind, action, request_id FROM audit_log WHERE tenant_id = $1 AND resource_id = $2', [tenant, uno.id]);
    expect(audit.rows).toEqual([{ actor: 'apikey:service-key', actor_kind: 'apikey', action: 'activity.created', request_id: requestId }]);
  });

  it('sin el scope de actividades rechaza con 403', async () => {
    const res = await actividadApi(contacto, {}, { 'X-Api-Key': 'test-read-only-key' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ requestId: expect.any(String), details: [] });
  });

  it('ids y vencimientos inválidos devuelven 400, sin errores SQL', async () => {
    expect((await actividadApi('sin-uuid', {})).status).toBe(400);
    expect((await actividadApi(contacto, { dealId: 'sin-uuid' })).status).toBe(400);
    expect((await actividadApi(contacto, { dueAt: 'mañana' })).status).toBe(400);
  });
});
