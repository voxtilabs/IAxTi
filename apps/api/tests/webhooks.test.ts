import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { Queue } from 'bullmq';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { redisConnection } from '@iaxti/core';
import { createChannelAccount, firmarWebhook, setChannelState } from '@iaxti/module-channels';
import { createApp } from '../src/main';

// El webhook base (#41): firma sobre el cuerpo crudo, cola con idempotencia
// por jobId y respuesta rápida. Ruta pública fuera de /v1.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let cuenta: string;
let queue: Queue;
const jobIds: string[] = [];

async function disparar(payload: unknown, firma?: string): Promise<Response> {
  const cuerpo = JSON.stringify(payload);
  return fetch(`${base}/webhooks/channels/${cuenta}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Iaxti-Signature': firma ?? firmarWebhook(cuerpo, 'secreto-webhook-test'),
    },
    body: cuerpo,
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  process.env.WEBHOOK_SECRET_TEST_API = 'secreto-webhook-test';
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-webhooks') RETURNING id");
  tenant = t.rows[0].id;
  const c = await withTenant(admin, tenant, (cl) =>
    createChannelAccount(cl, {
      tenantId: tenant,
      kind: 'simulador',
      name: 'Webhook de prueba',
      webhookSecretRef: 'WEBHOOK_SECRET_TEST_API',
    }),
  );
  cuenta = c.id;
  await withTenant(admin, tenant, (cl) =>
    setChannelState(cl, { tenantId: tenant, accountId: cuenta, state: 'active' }),
  );

  queue = new Queue('inbound', { connection: redisConnection() });
  app = await createApp({ jwtVerify: null, resolveRole: null });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  for (const id of jobIds) await queue.remove(id).catch(() => {});
  await queue.close();
  await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
  delete process.env.WEBHOOK_SECRET_TEST_API;
});

describe('POST /webhooks/channels/:accountId', () => {
  it('sin firma válida responde 401 y no encola nada', async () => {
    const res = await disparar({ messages: [{ id: 'w0', phone: '+56900001111', body: 'x' }] }, 'firma-falsa');
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('INVALID_SIGNATURE');
    expect(await queue.getJob(`in-${cuenta}-w0`)).toBeUndefined();
  });

  it('cuenta inexistente responde 404 sin filtrar nada', async () => {
    const cuerpo = JSON.stringify({ messages: [] });
    const res = await fetch(`${base}/webhooks/channels/${randomUUID()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: cuerpo,
    });
    expect(res.status).toBe(404);
  });

  it('con firma buena encola con idempotencia por id del proveedor y responde rápido', async () => {
    const payload = {
      messages: [
        { id: 'w1', phone: '+56900001111', body: 'hola por webhook' },
        { id: 'w2', phone: '+56900002222', body: 'otro' },
      ],
    };
    const inicio = Date.now();
    const res = await disparar(payload);
    const elapsed = Date.now() - inicio;
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ received: 2 });
    expect(elapsed).toBeLessThan(1000); // el criterio: 200 en menos de un segundo
    jobIds.push(`in-${cuenta}-w1`, `in-${cuenta}-w2`);

    const job = await queue.getJob(`in-${cuenta}-w1`);
    expect(job?.data).toMatchObject({
      moduleId: 'conversations',
      tenantId: tenant,
      channel: 'simulador',
      phone: '+56900001111',
      providerMessageId: 'w1',
    });

    // El webhook REPETIDO (Meta reintenta) no duplica: mismo jobId.
    const antes = await queue.getJobCountByTypes('waiting', 'delayed', 'completed', 'failed');
    const repetido = await disparar(payload);
    expect(repetido.status).toBe(201);
    const despues = await queue.getJobCountByTypes('waiting', 'delayed', 'completed', 'failed');
    expect(despues).toBe(antes);
  });
});
