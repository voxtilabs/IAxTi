import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, connect, type Socket } from 'node:net';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createQueue, ModuleRegistry, OutboxDispatcher, redisConnection, MAX_ATTEMPTS } from '@iaxti/core';
import { receiveInbound, retryOutboundDelivery, sendMessage } from '@iaxti/module-conversations';
import { createChannelAccount, registerProvider, resetProviders, setChannelState } from '@iaxti/module-channels';
import { createOutboundPublisher, outboundRequestConsumers } from '../src/outbound-dispatch';
import { processOutbound } from '../src/outbound';

let pool: Pool;
const redis = redisConnection();
const queue = createQueue('outbound', redis);
let publisher: ReturnType<typeof createOutboundPublisher>;
let registry: ModuleRegistry;
let tenantId: string;
let conversationId: string;
let sends = 0;
let messageIds: string[];
const event = async () => (await pool.query("SELECT id, attempts, processed_at, last_error FROM outbox WHERE tenant_id=$1 AND name='message.delivery_requested'", [tenantId])).rows[0];
const dispatch = (enqueue = publisher.enqueue) => new OutboxDispatcher(pool, registry, outboundRequestConsumers(enqueue, registry), 10_000);
async function message(policy: 'reply' | 'business' | 'transactional' = 'reply') {
  const m = await withTenant(pool, tenantId, c => sendMessage(c, {
    tenantId, conversationId, authorKind: 'system', body: 'privado', delivery: policy, requestId: 'req-durable-worker',
  }));
  messageIds.push(m.id);
  return m;
}
async function pending(attempts: number) {
  expect(await event()).toMatchObject({ attempts, processed_at: null });
  expect((await pool.query('SELECT consumer FROM processed_events WHERE event_id=$1', [(await event()).id])).rowCount).toBe(0);
}

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  await queue.waitUntilReady();
  registerProvider({ kind: 'whatsapp', verifyWebhook: () => true, normalize: () => [],
    send: async () => { sends++; return { providerMessageId: 'wamid.durable-test' }; },
  });
  process.env.DURABLE_TEST_KEY = 'solo-pruebas';
});
beforeEach(async () => {
  registry = new ModuleRegistry(resolve(__dirname, '../../../packages/modules')).load();
  publisher = createOutboundPublisher(process.env.REDIS_URL);
  messageIds = [];
  sends = 0;
  tenantId = (await pool.query("INSERT INTO tenants (name) VALUES ('durable-worker') RETURNING id")).rows[0].id;
  await withTenant(pool, tenantId, async c => {
    const account = await createChannelAccount(c, { tenantId, kind: 'whatsapp', name: 'pruebas', credentialRef: 'DURABLE_TEST_KEY', config: { phoneNumberId: 'durable' } });
    await setChannelState(c, { tenantId, accountId: account.id, state: 'active' });
    const inbound = await receiveInbound(c, { tenantId, channel: 'whatsapp', channelAccountId: account.id, phone: '+56944440000', body: 'hola' });
    conversationId = inbound.conversation.id;
  });
});
afterEach(async () => {
  await publisher.close();
  for (const id of messageIds) await (await queue.getJob(`out-${id}`))?.remove();
  await pool.query('DELETE FROM processed_events WHERE event_id IN (SELECT id FROM outbox WHERE tenant_id=$1)', [tenantId]);
  await pool.query('DELETE FROM outbox WHERE tenant_id=$1', [tenantId]);
});
afterAll(async () => {
  resetProviders(); delete process.env.DURABLE_TEST_KEY;
  await queue.close(); await redis.quit(); await pool.end();
});

describe('PostgreSQL → Redis durable (#380)', () => {
  it.each(['reply', 'business', 'transactional'] as const)('publica %s con identidad y política, sin datos personales', async policy => {
    const m = await message(policy);
    await dispatch().tick();
    const job = await queue.getJob(`out-${m.id}`);
    expect(job?.data).toEqual({ moduleId: 'whatsapp', tenantId, messageId: m.id, requestId: 'req-durable-worker',
      initiatedByBusiness: policy !== 'reply', ...(policy === 'transactional' ? { transaccional: true } : {}),
    });
    expect((await event()).processed_at).not.toBeNull();
  });

  it.each(['conversations', 'whatsapp'])('con %s apagado conserva el pedido y continúa al reactivarlo', async moduleId => {
    const m = await message();
    registry.killSwitch(moduleId, true);
    await dispatch().tick();
    await pending(1);
    expect(await queue.getJob(`out-${m.id}`)).toBeUndefined();
    registry.killSwitch(moduleId, false);
    await dispatch().tick();
    expect(await queue.getJob(`out-${m.id}`)).toBeDefined();
  });

  it('un reinicio tras aceptar Redis y revertir PostgreSQL reutiliza el mismo job', async () => {
    const m = await message();
    await dispatch(async j => { await publisher.enqueue(j); throw new Error('caída antes del commit'); }).tick();
    await pending(1);
    const first = await queue.getJob(`out-${m.id}`);
    expect(first).toBeDefined();
    await publisher.close();
    publisher = createOutboundPublisher(process.env.REDIS_URL);
    await dispatch().tick();
    const second = await queue.getJob(`out-${m.id}`);
    expect(second?.timestamp).toBe(first?.timestamp);
    expect((await event()).processed_at).not.toBeNull();
  });

  it('si el job ya salió y Redis lo olvidó, recuperar el pedido no vuelve a llamar al proveedor', async () => {
    const m = await message();
    await dispatch(async j => { await publisher.enqueue(j); throw new Error('commit fallido'); }).tick();
    const first = await queue.getJob(`out-${m.id}`);
    await processOutbound(pool, redis, first as never);
    expect(sends).toBe(1);
    await first!.remove();
    await dispatch().tick();
    await processOutbound(pool, redis, (await queue.getJob(`out-${m.id}`)) as never);
    expect(sends).toBe(1);
    expect((await pool.query('SELECT delivery_status FROM messages WHERE id=$1', [m.id])).rows[0].delivery_status).toBe('sent');
  });

  it('agotar cinco intentos conserva el mensaje; la recuperación autorizada retoma el mismo pedido', async () => {
    const m = await message();
    for (let i = 0; i < MAX_ATTEMPTS; i++) await dispatch(async () => { throw new Error('sin Redis'); }).tick();
    await pending(MAX_ATTEMPTS);
    await dispatch().tick();
    expect(await queue.getJob(`out-${m.id}`)).toBeUndefined();
    await withTenant(pool, tenantId, c => retryOutboundDelivery(c, { tenantId, conversationId, messageId: m.id, actor: 'sistema', actorKind: 'system' }));
    await dispatch().tick();
    expect(await queue.getJob(`out-${m.id}`)).toBeDefined();
    expect((await event()).processed_at).not.toBeNull();
  });

  it.each([{ policy: ['reply'] }, { policy: 'desconocido' }, { messageId: 'no-uuid' }])('rechaza un evento malformado: %j', async payload => {
    const m = await message();
    await pool.query("UPDATE outbox SET payload=payload || $2::jsonb WHERE tenant_id=$1 AND name='message.delivery_requested'", [tenantId, JSON.stringify(payload)]);
    await dispatch().tick();
    await pending(1);
    expect(await queue.getJob(`out-${m.id}`)).toBeUndefined();
  });

  it('acota un Redis que acepta TCP pero no responde, y reconecta cuando se recupera', async () => {
    const target = new URL(process.env.REDIS_URL!);
    let available = false;
    let connections = 0;
    const sockets = new Set<Socket>();
    const proxy = createServer(socket => {
      connections++;
      sockets.add(socket); socket.on('error', () => {});
      if (available) {
        const upstream = connect(Number(target.port || 6379), target.hostname);
        sockets.add(upstream); upstream.on('error', () => socket.destroy());
        socket.pipe(upstream).pipe(socket);
        socket.on('close', () => upstream.destroy());
      }
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address() as { port: number };
    const proxyUrl = new URL(process.env.REDIS_URL!);
    proxyUrl.hostname = '127.0.0.1'; proxyUrl.port = String(address.port);
    await publisher.close(); publisher = createOutboundPublisher(proxyUrl.toString(), 500);
    try {
      const m = await message();
      const start = Date.now();
      await dispatch().tick();
      expect(Date.now() - start).toBeLessThan(3_000);
      await pending(1);
      expect((await event()).last_error).toMatch(/pedido sigue en el outbox/);
      await dispatch().tick();
      await pending(2);
      expect(connections).toBe(1); // El resto del lote falla rápido, sin otra espera TCP.
      await new Promise(resolve => setTimeout(resolve, 1_010));
      available = true;
      await dispatch().tick();
      expect(await queue.getJob(`out-${m.id}`)).toBeDefined();
      expect((await event()).processed_at).not.toBeNull();
    } finally {
      await publisher.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  }, 10_000);
});
