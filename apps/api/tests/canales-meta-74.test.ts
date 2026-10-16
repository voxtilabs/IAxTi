import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import { createPool, runMigrations, withTenant, sinTriggers } from '@iaxti/db';
import { redisConnection } from '@iaxti/core';
import { conectarSender, type SenderZavu } from '@iaxti/module-whatsapp';
import { createChannelAccount, getChannelAccount, setChannelState } from '@iaxti/module-channels';
import { receiveInbound } from '@iaxti/module-conversations';
import { createApp } from '../src/main';
import { usarPool } from '../src/db';
import { registry } from '../src/app.module';
import { probarEnvio } from '../src/probar-envio';

const ownerUrl = process.env.DATABASE_URL!;
const admin = createPool(ownerUrl);
const safeUrl = new URL(process.env.DATABASE_URL!);
safeUrl.username = 'iaxti_api74'; safeUrl.password = 'iaxti_api74';
const safe = createPool(safeUrl.toString());
const secret = 'secreto-ficticio-del-webhook-74';
const senders = new Map<string, SenderZavu>();
const requests: string[] = [];
const tenants: string[] = [];
const jobIds: string[] = [];
let app: INestApplication; let base: string; let t: string; let ajeno: string; let primary: string; let senderId: string;
let queue: Queue;
const provider = createServer(async (req, res) => {
  requests.push(`${req.method} ${req.url}`);
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/me') { res.end(JSON.stringify({ project: { id: 'ficticio', name: 'Prueba' }, isTestMode: true })); return; }
  const sender = senders.get(req.url?.split('/').at(-1) ?? '');
  if (!sender) { res.writeHead(404).end('{}'); return; }
  if (req.method === 'PATCH') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); sender.webhook = { url: body.webhookUrl, active: true, signatureVersion: 'v2' };
  }
  res.end(JSON.stringify(sender));
});
const userId = randomUUID();
function headers(tenant = t, role = 'ADMIN') { return { Authorization: `Bearer ${role}`, 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' }; }
async function preparar(tenant: string, kind: 'instagram' | 'messenger') {
  const id = `snd-${randomUUID()}`; const sender = { id, name: 'Cuenta ficticia', channels: ['whatsapp', 'instagram', 'messenger'] };
  senders.set(id, sender);
  const { clienteZavu } = await import('@iaxti/module-whatsapp');
  const r = await withTenant(safe, tenant, (c) => conectarSender(c, { tenantId: tenant, nombre: 'Ficticia', sender, kind, baseUrl: base,
    credentialRef: 'TEST_74_KEY', webhookSecretRef: 'TEST_74_HOOK', llamar: clienteZavu('ficticio') }));
  return r;
}
beforeAll(async () => {
  await runMigrations(admin);
  await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='iaxti_api74') THEN CREATE ROLE iaxti_api74 LOGIN PASSWORD 'iaxti_api74'; END IF; END $$");
  expect((await admin.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='iaxti_api74'")).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  await admin.query('GRANT USAGE ON SCHEMA public TO iaxti_api74');
  await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO iaxti_api74');
  await admin.query('REVOKE UPDATE, DELETE ON audit_log, platform_audit FROM iaxti_api74');
  await admin.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO iaxti_api74');
  await admin.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO iaxti_api74');
  await new Promise<void>((ok) => provider.listen(0, '127.0.0.1', ok));
  process.env.ZAVU_API_BASE = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  process.env.TEST_74_KEY = 'ficticio'; process.env.TEST_74_HOOK = secret;
  for (let i = 0; i < 2; i++) tenants.push((await admin.query("INSERT INTO tenants(name, state) VALUES ('API ficticia 74', 'active') RETURNING id")).rows[0].id);
  [t, ajeno] = tenants;
  process.env.DATABASE_URL = safeUrl.toString();
  usarPool(safe);
  app = await createApp({ jwtVerify: async (token) => ({ userId: token === 'USER' ? 'lector' : userId }), resolveRole: async (_tenant, id) => id === 'lector' ? 'USER' : 'ADMIN',
    resolveApiKey: async (key) => key === 'api-ficticia' ? { id: userId, tenantId: t, scopes: ['channels.manage'] } : null,
    resolveAccesoModulo: null });
  await app.listen(0); base = await app.getUrl(); process.env.API_URL_PUBLIC = base;
  const r = await preparar(t, 'instagram'); primary = r.account.id; senderId = r.senderId;
  await preparar(ajeno, 'messenger');
  queue = new Queue('inbound', { connection: redisConnection() });
});
afterAll(async () => {
  for (const id of jobIds) await queue.remove(id);
  await queue.close(); await app.close(); usarPool(null); await safe.end();
  await new Promise<void>((ok, fail) => provider.close((e) => e ? fail(e) : ok()));
  await sinTriggers(admin, async (c) => {
    for (const table of ['channel_senders', 'messages', 'conversations', 'contact_identities', 'contacts', 'channel_accounts', 'audit_log', 'outbox']) {
      await c.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    }
    await c.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
  });
  await admin.end();
  process.env.DATABASE_URL = ownerUrl;
  for (const key of ['ZAVU_API_BASE', 'API_URL_PUBLIC', 'TEST_74_KEY', 'TEST_74_HOOK']) delete process.env[key];
});

describe('conexión Meta desde API real (#74)', () => {
  it('sin permiso no lista emisores; el módulo apagado tampoco conecta', async () => {
    const denied = await fetch(`${base}/v1/channels/conexiones-disponibles`, { headers: headers(t, 'USER') });
    expect(denied.status).toBe(403); expect((await denied.json()).code).toBe('PERMISSION_DENIED');
    registry.killSwitch('whatsapp', true);
    try {
      const off = await fetch(`${base}/v1/channels/conectar`, { method: 'POST', headers: headers(), body: JSON.stringify({ senderId, kind: 'instagram' }) });
      expect(off.status).toBe(403); expect((await off.json()).code).toBe('MODULE_DISABLED');
    } finally { registry.killSwitch('whatsapp', false); }
  });
  it('consulta solo sender acreditado, no lista global ni refs; no puede conectar el de otro tenant', async () => {
    requests.length = 0;
    const r = await fetch(`${base}/v1/channels/conexiones-disponibles`, { headers: headers() });
    expect(r.status).toBe(200); const opciones = await r.json();
    expect(opciones).toEqual([{ senderId, kind: 'instagram', name: 'Cuenta ficticia' }, { senderId, kind: 'messenger', name: 'Cuenta ficticia' }]);
    expect(requests).toEqual([`GET /senders/${senderId}`]);
    const bad = await fetch(`${base}/v1/channels/conectar`, { method: 'POST', headers: headers(ajeno), body: JSON.stringify({ senderId, kind: 'instagram' }) });
    expect(bad.status).toBe(404);
  });
  it('no activa con webhook incorrecto o secreto ausente y luego registra API key real', async () => {
    const sender = senders.get(senderId)!; const hook = sender.webhook!;
    sender.webhook = { ...hook, url: 'https://example.test/otro' };
    const conectar = () => fetch(`${base}/v1/channels/conectar`, { method: 'POST', headers: { 'X-Api-Key': 'api-ficticia', 'Content-Type': 'application/json' }, body: JSON.stringify({ senderId, kind: 'instagram' }) });
    expect((await conectar()).status).toBe(400);
    sender.webhook = hook; delete process.env.TEST_74_HOOK;
    expect((await conectar()).status).toBe(503); process.env.TEST_74_HOOK = secret;
    requests.length = 0;
    const ok = await conectar(); expect(ok.status).toBe(201); expect((await ok.json()).state).toBe('active');
    expect(requests.every((r) => r.startsWith('GET '))).toBe(true);
    const audit = await admin.query("SELECT actor, actor_kind FROM audit_log WHERE tenant_id=$1 AND action='channel.connected' AND resource_id=$2", [t, primary]);
    expect(audit.rows).toEqual([{ actor: `apikey:${userId}`, actor_kind: 'apikey' }]);
  });
  it('segunda cuenta conserva hook y un webhook firmado selecciona Messenger, incluso con primaria archivada', async () => {
    const conectar = () => fetch(`${base}/v1/channels/conectar`, { method: 'POST', headers: headers(), body: JSON.stringify({ senderId, kind: 'messenger' }) });
    const [r, repetida] = await Promise.all([conectar(), conectar()]);
    expect(r.status).toBe(201); expect(repetida.status).toBe(201); const messenger = await r.json();
    expect((await repetida.json()).id).toBe(messenger.id);
    expect((await admin.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id=$1 AND action='channel.connected' AND resource_id=$2", [t, messenger.id])).rows[0].n).toBe(1);
    await withTenant(safe, t, (c) => setChannelState(c, { tenantId: t, accountId: primary, state: 'disconnected' }));
    const id = randomUUID(); const body = JSON.stringify({ id: `evt-${id}`, type: 'message.inbound', senderId, timestamp: Date.now(), data: { channel: 'messenger', messageId: id, from: '24025631120151183', messageType: 'text', text: 'Hola ficticio' } });
    const timestamp = Math.floor(Date.now() / 1000); const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const response = await fetch(`${base}/webhooks/channels/${primary}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zavu-Signature': `t=${timestamp},v2=${signature}` }, body });
    expect(response.status).toBe(201);
    const jobId = `in-${messenger.id}-${id}`; jobIds.push(jobId);
    const job = await queue.getJob(jobId); expect(job?.data).toMatchObject({ tenantId: t, channelAccountId: messenger.id, channel: 'messenger', phone: '24025631120151183' });
    const bad = await fetch(`${base}/webhooks/channels/${primary}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zavu-Signature': 'falsa' }, body });
    expect(bad.status).toBe(401);
    for (const sobre of [
      { ...JSON.parse(body), senderId: 'sender-ajeno' },
      { ...JSON.parse(body), data: { ...JSON.parse(body).data, channel: 'instagram' } },
    ]) {
      const equivocado = JSON.stringify(sobre);
      const firma = createHmac('sha256', secret).update(`${timestamp}.${equivocado}`).digest('hex');
      const rechazado = await fetch(`${base}/webhooks/channels/${primary}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zavu-Signature': `t=${timestamp},v2=${firma}` }, body: equivocado });
      expect(rechazado.status).toBe(404);
    }
  });
  it.each(['instagram', 'messenger'] as const)('la prueba de %s usa identidad y ventana de SU cuenta, sin crear contacto', async (kind) => {
    const preparada = await preparar(t, kind);
    await withTenant(safe, t, (c) => setChannelState(c, { tenantId: t, accountId: preparada.account.id, state: 'active' }));
    const ahora = new Date('2026-03-10T18:00:00Z'); const destino = `${kind === 'instagram' ? '1784' : '2402'}000000000001`;
    await withTenant(safe, t, (c) => receiveInbound(c, { tenantId: t, channel: kind, channelAccountId: preparada.account.id, phone: destino, providerMessageId: randomUUID(), body: 'Hola' }));
    await admin.query("UPDATE conversations SET last_inbound_at=$2::timestamptz - interval '1 hour' WHERE tenant_id=$1 AND channel_account_id=$3", [t, ahora, preparada.account.id]);
    const llamadas: string[] = [];
    const deps = { pool: safe, redis: null, ahora, despachar: async (_a: unknown, data: { to: string }) => { llamadas.push(data.to); return { providerMessageId: 'ficticio' }; } };
    expect((await probarEnvio(deps, { tenantId: t, accountId: preparada.account.id, telefono: destino })).ok).toBe(true);
    expect(llamadas).toEqual([destino]);
    await admin.query("UPDATE conversations SET last_inbound_at=$2::timestamptz - interval '25 hours' WHERE tenant_id=$1 AND channel_account_id=$3", [t, ahora, preparada.account.id]);
    expect((await probarEnvio(deps, { tenantId: t, accountId: preparada.account.id, telefono: destino })).motivo).toBe('VENTANA_CERRADA');
    // Una cuenta distinta del mismo canal/contacto no reabre esta ventana.
    const otra = await preparar(t, kind);
    await withTenant(safe, t, (c) => receiveInbound(c, { tenantId: t, channel: kind, channelAccountId: otra.account.id, phone: destino, providerMessageId: randomUUID(), body: 'Otra cuenta' }));
    expect((await probarEnvio(deps, { tenantId: t, accountId: preparada.account.id, telefono: destino })).motivo).toBe('VENTANA_CERRADA');
    expect((await probarEnvio(deps, { tenantId: ajeno, accountId: preparada.account.id, telefono: destino })).motivo).toBe('CANAL_NO_ACTIVO');
    expect(llamadas).toHaveLength(1);
    expect((await withTenant(safe, t, (c) => getChannelAccount(c, t, preparada.account.id))).kind).toBe(kind);
  });
  it('un sender histórico ambiguo conserva dueño y el webhook que apunta a su segunda cuenta', async () => {
    const sender = `historico-${randomUUID()}`;
    const cuentas = await withTenant(safe, t, async (c) => {
      const creadas = [];
      for (const name of ['Primera histórica', 'Receptor real histórico']) {
        const a = await createChannelAccount(c, { tenantId: t, kind: 'instagram', name, credentialRef: 'TEST_74_KEY', webhookSecretRef: 'TEST_74_HOOK', config: { senderId: sender } });
        creadas.push(await setChannelState(c, { tenantId: t, accountId: a.id, state: 'active' }));
      }
      return creadas;
    });
    // Estado que produce la migración: dueño conocido, receptor desconocido.
    await admin.query('INSERT INTO channel_senders(sender_id,tenant_id,webhook_account_id) VALUES($1,$2,NULL)', [sender,t]);
    const id = randomUUID(); const receptor = cuentas[1];
    const body = JSON.stringify({ id: `evt-${id}`, type: 'message.inbound', senderId: sender, timestamp: Date.now(), data: { channel: 'instagram', messageId: id, from: '1784000000000099', messageType: 'text', text: 'Entrada histórica' } });
    const timestamp = Math.floor(Date.now() / 1000); const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const r = await fetch(`${base}/webhooks/channels/${receptor.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zavu-Signature': `t=${timestamp},v2=${signature}` }, body });
    expect(r.status).toBe(201);
    const jobId = `in-${receptor.id}-${id}`; jobIds.push(jobId);
    expect((await queue.getJob(jobId))?.data).toMatchObject({ channelAccountId: receptor.id, channel: 'instagram', tenantId: t });
    expect(await queue.getJob(`in-${cuentas[0].id}-${id}`)).toBeUndefined();
    expect((await admin.query('SELECT * FROM channel_senders WHERE sender_id=$1', [sender])).rows).toEqual([{ sender_id: sender, tenant_id: t, webhook_account_id: null }]);
    const ajena = await fetch(`${base}/v1/channels/conectar`, { method: 'POST', headers: headers(ajeno), body: JSON.stringify({ senderId: sender, kind: 'instagram' }) });
    expect(ajena.status).toBe(404);
  });
});
