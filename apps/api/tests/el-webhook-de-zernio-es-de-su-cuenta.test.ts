import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { urlDeLaApp } from './url-de-la-app';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { Queue } from 'bullmq';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { redisConnection } from '@iaxti/core';
import { createChannelAccount, setChannelState } from '@iaxti/module-channels';
import { createApp } from '../src/main';

/**
 * El webhook de Zernio entra solo si es de SU cuenta y de SU negocio (#1321).
 *
 * La firma prueba que el evento viene de Zernio, no que sea de esta cuenta.
 * Acá se manda, con la firma BUENA, un evento de otro negocio — el cruce a
 * propósito del criterio 4 — y tiene que quedar afuera y anotado como
 * `perfil_ajeno`, que es lo que deja al diagnóstico distinguirlo de un secreto
 * malo.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const SECRETO = 'secreto-zernio-1321';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let cuenta: string;
let queue: Queue;
const jobIds: string[] = [];

function evento(over: { externalId?: string; accountId?: string; test?: boolean; id: string }) {
  return {
    id: `evt_${over.id}`,
    event: 'message.received',
    ...(over.test ? { test: true } : {}),
    profiles: [{ id: 'prof_1321', externalId: over.externalId ?? tenant }],
    account: { id: over.accountId ?? 'acc_1321', accountId: over.accountId ?? 'acc_1321', profileId: 'prof_1321', platform: 'whatsapp' },
    message: {
      id: over.id,
      conversationId: 'conv_1321',
      platformMessageId: `wamid.${over.id}`,
      direction: 'incoming',
      text: 'hola',
      sender: { phoneNumber: '+56933334444' },
    },
  };
}

async function disparar(payload: unknown): Promise<Response> {
  const cuerpo = JSON.stringify(payload);
  return fetch(`${base}/webhooks/channels/${cuenta}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Zernio-Signature': createHmac('sha256', SECRETO).update(cuerpo, 'utf8').digest('hex'),
    },
    body: cuerpo,
  });
}

const resultado = async () =>
  (await admin.query('SELECT last_webhook_result FROM channel_accounts WHERE id = $1', [cuenta])).rows[0]
    .last_webhook_result as string | null;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  process.env.ZERNIO_WEBHOOK_SECRET_1321 = SECRETO;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('test-zernio-1321') RETURNING id")).rows[0].id;
  queue = new Queue('inbound', { connection: redisConnection() });
  // La app primero: es la que registra el adaptador de Zernio, y sin él la
  // cuenta no se puede crear declarando a Zernio.
  app = await createApp({ jwtVerify: null, resolveRole: null });
  await app.listen(0);
  base = urlDeLaApp(app);
  cuenta = (
    await withTenant(admin, tenant, (c) =>
      createChannelAccount(c, {
        tenantId: tenant,
        kind: 'whatsapp',
        name: 'Zernio de prueba',
        provider: 'zernio',
        credentialRef: 'ZERNIO_LLAVE_1321',
        webhookSecretRef: 'ZERNIO_WEBHOOK_SECRET_1321',
        config: { zernioAccountId: 'acc_1321', zernioProfileId: 'prof_1321', senderId: 'zernio:acc_1321' },
      }),
    )
  ).id;
  await withTenant(admin, tenant, (c) => setChannelState(c, { tenantId: tenant, accountId: cuenta, state: 'active' }));
});

afterAll(async () => {
  await app.close();
  for (const id of jobIds) await queue.remove(id).catch(() => {});
  await queue.close();
  await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
  delete process.env.ZERNIO_WEBHOOK_SECRET_1321;
});

describe('POST /webhooks/channels/:id con una cuenta de Zernio', () => {
  it('el evento de su cuenta y su negocio entra a la cola', async () => {
    const res = await disparar(evento({ id: 'ok1' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ received: 1, statuses: 0 });
    const jobId = `in-${cuenta}-wamid.ok1`;
    jobIds.push(jobId);
    expect(await queue.getJob(jobId)).toBeTruthy();
    expect(await resultado()).toBe('aceptado');
  });

  it('el cruce a propósito: firma buena, perfil de OTRO negocio → afuera y anotado', async () => {
    const otro = '33333333-3333-4333-8333-333333333333';
    const res = await disparar(evento({ id: 'cruce1', externalId: otro }));
    expect(res.status).toBe(404);
    expect(await queue.getJob(`in-${cuenta}-wamid.cruce1`)).toBeUndefined();
    expect(await resultado()).toBe('perfil_ajeno');
  });

  it('firma buena, OTRA cuenta de Zernio → afuera', async () => {
    const res = await disparar(evento({ id: 'cruce2', accountId: 'acc_ajena' }));
    expect(res.status).toBe(404);
    expect(await queue.getJob(`in-${cuenta}-wamid.cruce2`)).toBeUndefined();
  });

  it('un mensaje sin teléfono no entra, pero queda contado (#1331)', async () => {
    const sinNumero = evento({ id: 'sintel1' });
    (sinNumero.message.sender as { phoneNumber: string | null }).phoneNumber = null;
    const res = await disparar(sinNumero);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ received: 0, statuses: 0 });
    expect(await queue.getJob(`in-${cuenta}-wamid.sintel1`)).toBeUndefined();
    const fila = (await admin.query('SELECT inbound_sin_telefono FROM channel_accounts WHERE id = $1', [cuenta])).rows[0];
    expect(fila.inbound_sin_telefono).toBe(1);
  });

  it('la muestra de prueba de Zernio confirma el webhook sin encolar nada', async () => {
    const res = await disparar(evento({ id: 'muestra', test: true, accountId: 'inventada' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ received: 0, statuses: 0 });
    expect(await queue.getJob(`in-${cuenta}-wamid.muestra`)).toBeUndefined();
    expect(await resultado()).toBe('aceptado');
  });
});
