import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound, sendMessage } from '@iaxti/module-conversations';
import { createChannelAccount, setChannelState } from '@iaxti/module-channels';
import { createApp } from '../src/main';

let app: INestApplication;
let pool: Pool;
let base: string;
let tenant: string;
let template: string;
const owner = randomUUID();
const seller = randomUUID();
const colleague = randomUUID();
const apiKeyId = randomUUID();
const requestId = 'req_delivery_api_test';
async function post(path: string, body: unknown = {}, user = owner, tenantId = tenant) {
  return fetch(`${base}/v1${path}`, { method: 'POST', headers: {
    authorization: `Bearer ${user}`, 'x-tenant-id': tenantId,
    'content-type': 'application/json', 'x-request-id': requestId,
  }, body: JSON.stringify(body) });
}
async function conversation(channel: 'whatsapp' | 'instagram' = 'whatsapp') {
  const res = await withTenant(pool, tenant, c => receiveInbound(c, {
    tenantId: tenant, phone: `+569${Math.floor(Math.random() * 90_000_000 + 10_000_000)}`, channel, body: 'hola',
  }));
  return res.conversation.id;
}
async function expectRequest(id: string, policy: string) {
  const r = await pool.query("SELECT payload, request_id FROM outbox WHERE tenant_id=$1 AND name='message.delivery_requested' AND payload->>'messageId'=$2", [tenant, id]);
  expect(r.rows).toEqual([{ payload: { messageId: id, policy }, request_id: requestId }]);
  expect((await pool.query('SELECT delivery_status FROM messages WHERE id=$1', [id])).rows[0].delivery_status).toBe('queued');
}
async function exhausted() {
  const id = await conversation();
  await pool.query('UPDATE conversations SET owner_id=$2 WHERE id=$1', [id, seller]);
  const m = await withTenant(pool, tenant, c => sendMessage(c, {
    tenantId: tenant, conversationId: id, authorKind: 'user', authorId: seller, body: 'pendiente', delivery: 'reply',
  }));
  await pool.query("UPDATE outbox SET attempts=5,last_error='sin Redis' WHERE tenant_id=$1 AND payload->>'messageId'=$2", [tenant, m.id]);
  return { id, messageId: m.id, path: `/conversations/${id}/messages/${m.id}/retry-delivery` };
}

beforeAll(async () => {
  pool = createPool(); await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants (name,plan) VALUES ('api-durable','crece') RETURNING id")).rows[0].id;
  template = (await pool.query("INSERT INTO whatsapp_templates (tenant_id,name,language,category,body,status,provider_id) VALUES ($1,'saludo','es_CL','utility','Hola','approved','template-fixture') RETURNING id", [tenant])).rows[0].id;
  const account = await withTenant(pool, tenant, c => createChannelAccount(c, { tenantId: tenant, kind: 'whatsapp', name: 'prueba', credentialRef: 'DURABLE_UNUSED', config: {} }));
  await withTenant(pool, tenant, c => setChannelState(c, { tenantId: tenant, accountId: account.id, state: 'active' }));
  await pool.query("INSERT INTO whatsapp_numbers (tenant_id,channel_account_id,phone_number_id,quality) VALUES ($1,$2,$3,'green')", [tenant, account.id, randomUUID()]);
  process.env.DURABLE_PAYMENTS_TEST = 'solo-pruebas';
  await pool.query("INSERT INTO payment_providers (tenant_id,kind,name,credential_ref,mode,active) VALUES ($1,'simulado','simulado','DURABLE_PAYMENTS_TEST','test',true)", [tenant]);
  // Solo se sustituye la verificación criptográfica; guard, permisos, objeto,
  // transacciones y casos de uso son los reales. JWT tiene su propia suite.
  app = await createApp({
    jwtVerify: async token => ({ userId: token }),
    resolveRole: async (t, u) => t !== tenant ? null : u === owner ? 'ADMIN' : u === seller || u === colleague ? 'USER' : null,
    resolveApiKey: async token => ['recuperar', 'solo-reply'].includes(token) ? {
      id: apiKeyId, tenantId: tenant,
      scopes: token === 'recuperar' ? ['conversations.reply', 'conversations.read_all'] : ['conversations.reply'],
    } : null,
  });
  await app.listen(0); base = await app.getUrl();
});
afterAll(async () => {
  await app.close();
  delete process.env.DURABLE_PAYMENTS_TEST;
  await pool.query('DELETE FROM processed_events WHERE event_id IN (SELECT id FROM outbox WHERE tenant_id=$1)', [tenant]);
  await pool.query('DELETE FROM outbox WHERE tenant_id=$1', [tenant]);
  await pool.end();
});

describe('emisores HTTP con pedido durable (#380)', () => {
  it('una respuesta humana confirma el pedido junto al mensaje', async () => {
    const id = await conversation();
    const res = await post(`/conversations/${id}/messages`, { body: 'respuesta' });
    expect(res.status).toBe(201);
    await expectRequest((await res.json()).id, 'reply');
  });

  it('enviar una sugerencia usa la misma política de respuesta', async () => {
    const id = await conversation();
    const suggestion = (await pool.query("INSERT INTO suggestions (tenant_id,conversation_id,text) VALUES ($1,$2,'respuesta sugerida') RETURNING id", [tenant, id])).rows[0].id;
    const res = await post(`/conversations/${id}/suggestions/${suggestion}/send`);
    expect(res.status).toBe(201);
    await expectRequest((await res.json()).id, 'reply');
  });

  it('una plantilla conserva el envío de negocio y su metadata antes del commit', async () => {
    const id = await conversation();
    const res = await post(`/plantillas/${template}/enviar`, { conversationId: id });
    expect(res.status).toBe(201);
    const messageId = (await res.json()).messageId;
    await expectRequest(messageId, 'business');
    expect((await pool.query('SELECT type,meta FROM messages WHERE id=$1', [messageId])).rows[0]).toMatchObject({ type: 'plantilla' });
  });

  it('cada destinatario de una campaña conserva su pedido con política de negocio', async () => {
    await conversation();
    const create = await post('/campanas', { name: 'campaña prueba', templateId: template, filtros: {} });
    expect(create.status).toBe(201);
    const campaignId = (await create.json()).id;
    const res = await post(`/campanas/${campaignId}/enviar`);
    expect(res.status).toBe(201);
    const messages = await pool.query('SELECT message_id FROM campaign_recipients WHERE tenant_id=$1 AND campaign_id=$2 AND message_id IS NOT NULL', [tenant, campaignId]);
    expect(messages.rowCount).toBeGreaterThan(0);
    for (const row of messages.rows) await expectRequest(row.message_id, 'business');
  });

  it.each(['whatsapp', 'instagram'] as const)('un link de pago por %s espera al proveedor', async channel => {
    const id = await conversation(channel);
    const res = await post('/payments/links', { conversationId: id, amountClp: 15000, concept: 'prueba' });
    expect(res.status).toBe(201);
    const messageId = (await pool.query("SELECT id FROM messages WHERE conversation_id=$1 AND direction='out'", [id])).rows[0].id;
    await expectRequest(messageId, 'reply');
  });
});

describe('recuperación HTTP autorizada (#380)', () => {
  it('el dueño recupera una vez y deja requestId en auditoría', async () => {
    const m = await exhausted();
    const res = await post(m.path, {}, seller);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ messageId: m.messageId });
    expect((await post(m.path, {}, seller)).status).toBe(409);
    const audit = await pool.query("SELECT actor,request_id FROM audit_log WHERE resource_id=$1 AND action='message.delivery_retried'", [m.messageId]);
    expect(audit.rows).toEqual([{ actor: seller, request_id: requestId }]);
  });

  it('un colega sin permiso sobre la conversación y otro tenant no pueden recuperar', async () => {
    const m = await exhausted();
    expect((await post(m.path, {}, colleague)).status).toBe(403);
    expect((await post(m.path, {}, seller, randomUUID())).status).toBe(403);
    expect((await pool.query("SELECT attempts FROM outbox WHERE tenant_id=$1 AND payload->>'messageId'=$2", [tenant, m.messageId])).rows[0].attempts).toBe(5);
  });

  it('rechaza IDs inválidos y mensajes de otra conversación', async () => {
    const m = await exhausted();
    expect((await post(`/conversations/${m.id}/messages/no-uuid/retry-delivery`)).status).toBe(400);
    expect((await post(`/conversations/${await conversation()}/messages/${m.messageId}/retry-delivery`)).status).toBe(409);
  });

  it('una API key respeta el alcance sobre el dueño y conserva su identidad de servicio', async () => {
    const m = await exhausted();
    const call = (key: string) => fetch(`${base}/v1${m.path}`, { method: 'POST', headers: {
      'x-api-key': key, 'x-request-id': requestId,
    } });
    expect((await call('solo-reply')).status).toBe(403);
    const recovered = await call('recuperar');
    expect(recovered.status, await recovered.clone().text()).toBe(201);
    expect((await pool.query("SELECT actor,actor_kind FROM audit_log WHERE resource_id=$1 AND action='message.delivery_retried'", [m.messageId])).rows)
      .toEqual([{ actor: `apikey:${apiKeyId}`, actor_kind: 'apikey' }]);
  });
});
