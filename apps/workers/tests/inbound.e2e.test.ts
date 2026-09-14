// E2E de la bandeja (#36): el simulador encola en la cola REAL `inbound` de
// BullMQ y el worker real procesa — el mismo camino de código que usará el
// canal de WhatsApp en Fase 3. Necesita Postgres y Redis (docker compose up).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { Queue, QueueEvents } from 'bullmq';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { ModuleRegistry, createModuleWorker, createQueue, redisConnection } from '@iaxti/core';
import { changeConversationState } from '@iaxti/module-conversations';
import { processInbound, type InboundJob, type InboundOutcome } from '../src/inbound';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let queue: Queue;
let events: QueueEvents;
let worker: ReturnType<typeof createModuleWorker>;
let tenant: string;

async function simular(data: Omit<InboundJob, 'moduleId' | 'tenantId'>): Promise<InboundOutcome> {
  const job = await queue.add('simulado', {
    moduleId: 'conversations',
    tenantId: tenant,
    ...data,
  } satisfies InboundJob);
  return (await job.waitUntilFinished(events, 15_000)) as InboundOutcome;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('e2e-bandeja') RETURNING id");
  tenant = t.rows[0].id;

  const registry = new ModuleRegistry().load();
  queue = createQueue('inbound', redisConnection());
  await queue.obliterate({ force: true }); // sin restos de corridas anteriores
  events = new QueueEvents('inbound', { connection: redisConnection() });
  await events.waitUntilReady();
  worker = createModuleWorker(
    'inbound',
    registry,
    async (job) => processInbound(admin, job.data as InboundJob),
    redisConnection(),
  );
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await events?.close();
  await queue?.close();
  if (tenant) {
    await admin.query('DELETE FROM assignments WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  }
  await admin.end();
});

describe('simulador → cola inbound → worker (e2e)', () => {
  it('un contacto nuevo crea contacto, conversación new y mensaje entrante', async () => {
    const res = await simular({ phone: '+56 9 4444 5555', body: 'Hola, ¿tienen horas?' });
    expect(res.contactCreated).toBe(true);
    expect(res.conversationCreated).toBe(true);
    expect(res.optedOut).toBe(false);

    const conv = await admin.query('SELECT state, last_inbound_at FROM conversations WHERE id = $1', [
      res.conversationId,
    ]);
    expect(conv.rows[0].state).toBe('new');
    expect(conv.rows[0].last_inbound_at).not.toBeNull();
    const msg = await admin.query('SELECT direction, body FROM messages WHERE id = $1', [res.messageId]);
    expect(msg.rows[0]).toEqual({ direction: 'in', body: 'Hola, ¿tienen horas?' });
  });

  it('el contacto existente cae en la misma conversación', async () => {
    const res = await simular({ phone: '+56944445555', body: '¿Sigue disponible?' });
    expect(res.contactCreated).toBe(false);
    expect(res.conversationCreated).toBe(false);
    const n = await admin.query(
      'SELECT count(*)::int AS n FROM conversations WHERE tenant_id = $1',
      [tenant],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('la respuesta del cliente reabre una conversación resuelta', async () => {
    const conv = await admin.query('SELECT id FROM conversations WHERE tenant_id = $1 LIMIT 1', [tenant]);
    await withTenant(admin, tenant, (c) =>
      changeConversationState(c, {
        tenantId: tenant,
        conversationId: conv.rows[0].id,
        state: 'resolved',
        actor: 'e2e',
      }),
    );
    const res = await simular({ phone: '+56944445555', body: 'me quedó una duda' });
    expect(res.reopened).toBe(true);
    expect(res.conversationId).toBe(conv.rows[0].id);
    const estado = await admin.query('SELECT state FROM conversations WHERE id = $1', [conv.rows[0].id]);
    expect(estado.rows[0].state).toBe('new'); // sin dueño: vuelve a la cola
  });

  it('"BASTA" marca el opt-out por el mismo camino', async () => {
    const res = await simular({ phone: '+56 9 6666 7777', body: 'BASTA' });
    expect(res.optedOut).toBe(true);
    const contacto = await admin.query('SELECT opted_out_at FROM contacts WHERE id = $1', [res.contactId]);
    expect(contacto.rows[0].opted_out_at).not.toBeNull();
  });
}, 30_000);
