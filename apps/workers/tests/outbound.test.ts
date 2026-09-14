import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { redisConnection } from '@iaxti/core';
import type IORedis from 'ioredis';
import {
  receiveInbound,
  sendMessage,
} from '@iaxti/module-conversations';
import {
  createChannelAccount,
  registerProvider,
  resetProviders,
  setChannelState,
} from '@iaxti/module-channels';
import type { ChannelProvider } from '@iaxti/module-channels';
import { DelayUntilError, processOutbound } from '../src/outbound';
import { processDeliveryStatuses } from '../src/delivery';
import { applyQualityUpdate, connectWhatsAppNumber } from '@iaxti/module-whatsapp';

// La salida completa (#43) con un adaptador falso detrás del puerto:
// entrega → sent con wamid; fallo definitivo → failed con causa legible;
// silencio del tenant frena lo iniciado por el negocio; y el webhook de
// estados deja delivered/read con costo visible.

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let redis: IORedis;
let tenant: string;
let conversacion: string;
let account: string;
let modo: 'ok' | 'fallo' = 'ok';

const fakeProvider: ChannelProvider = {
  kind: 'whatsapp',
  async send() {
    if (modo === 'fallo') throw new Error('WhatsApp no aceptó el envío: HTTP 400');
    return { providerMessageId: `wamid.fake-${Math.random().toString(36).slice(2, 8)}` };
  },
  verifyWebhook: () => true,
  normalize: () => [],
};

async function nuevoSaliente(): Promise<string> {
  const m = await withTenant(admin, tenant, (c) =>
    sendMessage(c, {
      tenantId: tenant,
      conversationId: conversacion,
      authorKind: 'user',
      body: 'respuesta saliente',
    }),
  );
  return m.id;
}

function jobPara(messageId: string, extra: Record<string, unknown> = {}, attemptsMade = 0) {
  return {
    attemptsMade,
    opts: { attempts: 5 },
    data: {
      moduleId: 'whatsapp' as const,
      tenantId: tenant,
      messageId,
      channelAccountId: account,
      to: '',
      ...extra,
    },
  };
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  redis = redisConnection();
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('outbound-test') RETURNING id");
  tenant = t.rows[0].id;

  resetProviders();
  registerProvider(fakeProvider);
  process.env.FAKE_WA_KEY = 'clave';

  const cuenta = await withTenant(admin, tenant, (c) =>
    createChannelAccount(c, {
      tenantId: tenant,
      kind: 'whatsapp',
      name: 'Falso',
      credentialRef: 'FAKE_WA_KEY',
      config: { phoneNumberId: 'pn-out-test' },
    }),
  );
  account = cuenta.id;
  await withTenant(admin, tenant, (c) =>
    setChannelState(c, { tenantId: tenant, accountId: account, state: 'active' }),
  );

  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: '+56942220001',
      channel: 'whatsapp',
      channelAccountId: account,
      body: 'hola, quiero info',
    }),
  );
  conversacion = res.conversation.id;
});

afterAll(async () => {
  resetProviders();
  delete process.env.FAKE_WA_KEY;
  await redis.quit();
  await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM whatsapp_numbers WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('processOutbound (#43)', () => {
  it('entrega por el adaptador y deja sent con el wamid en el mensaje', async () => {
    modo = 'ok';
    const messageId = await nuevoSaliente();
    const res = await processOutbound(admin, redis, jobPara(messageId) as never);
    expect(res.providerMessageId).toMatch(/^wamid\.fake-/);
    const fila = await admin.query(
      'SELECT delivery_status, provider_message_id FROM messages WHERE id = $1',
      [messageId],
    );
    expect(fila.rows[0].delivery_status).toBe('sent');
    expect(fila.rows[0].provider_message_id).toBe(res.providerMessageId);
  });

  it('el fallo NO definitivo relanza (BullMQ reintenta); el definitivo queda failed con causa', async () => {
    modo = 'fallo';
    const messageId = await nuevoSaliente();
    await expect(
      processOutbound(admin, redis, jobPara(messageId, {}, 0) as never),
    ).rejects.toThrow(/HTTP 400/);

    const final = await processOutbound(admin, redis, jobPara(messageId, {}, 4) as never);
    expect(final.failed).toBeTruthy();
    const fila = await admin.query('SELECT delivery_status, meta FROM messages WHERE id = $1', [messageId]);
    expect(fila.rows[0].delivery_status).toBe('failed');
    expect(String(fila.rows[0].meta.error)).toMatch(/WhatsApp no aceptó/);
    modo = 'ok';
  });

  it('lo INICIADO POR EL NEGOCIO respeta el silencio; responder nunca espera', async () => {
    await admin.query(
      `UPDATE tenants SET settings = settings || '{"bandeja":{"silencio":{"desde":"00:00","hasta":"23:59","zona":"America/Santiago"}}}'::jsonb
       WHERE id = $1`,
      [tenant],
    );
    const iniciado = await nuevoSaliente();
    await expect(
      processOutbound(admin, redis, jobPara(iniciado, { initiatedByBusiness: true }) as never),
    ).rejects.toThrow(DelayUntilError);

    const respuesta = await nuevoSaliente();
    const res = await processOutbound(admin, redis, jobPara(respuesta) as never);
    expect(res.providerMessageId).toBeTruthy(); // la respuesta salió igual
    await admin.query(`UPDATE tenants SET settings = '{}'::jsonb WHERE id = $1`, [tenant]);
  });
});

describe('pausa por calidad (#45)', () => {
  it('en rojo, lo del negocio queda failed con la causa; la respuesta sigue saliendo', async () => {
    modo = 'ok';
    await admin.query("UPDATE tenants SET plan = 'crece' WHERE id = $1", [tenant]);
    await withTenant(admin, tenant, (c) =>
      connectWhatsAppNumber(c, {
        tenantId: tenant,
        name: 'Con calidad',
        phoneNumberId: 'pn-out-quality',
        credentialRef: 'FAKE_WA_KEY',
        webhookSecretRef: 'Y',
      }),
    ).then(async (res) => {
      // La conversación de este test usa la cuenta original: apuntamos el
      // número de calidad a ESA cuenta para que la pausa la cubra.
      await admin.query('UPDATE whatsapp_numbers SET channel_account_id = $1 WHERE id = $2', [account, res.number.id]);
    });
    await withTenant(admin, tenant, (c) =>
      applyQualityUpdate(c, { tenantId: tenant, update: { phoneNumberId: 'pn-out-quality', quality: 'red' } }),
    );

    const iniciado = await nuevoSaliente();
    const res = await processOutbound(admin, redis, jobPara(iniciado, { initiatedByBusiness: true }) as never);
    expect(res.failed).toMatch(/pausamos los envíos/);
    const fila = await admin.query('SELECT delivery_status FROM messages WHERE id = $1', [iniciado]);
    expect(fila.rows[0].delivery_status).toBe('failed');

    const respuesta = await nuevoSaliente();
    const ok = await processOutbound(admin, redis, jobPara(respuesta) as never);
    expect(ok.providerMessageId).toBeTruthy(); // responder nunca se pausa
  });
});

describe('estados del webhook (#43)', () => {
  it('delivered y read con costo quedan en el mensaje; failed trae causa legible', async () => {
    modo = 'ok';
    const messageId = await nuevoSaliente();
    const enviado = await processOutbound(admin, redis, jobPara(messageId) as never);
    const wamid = enviado.providerMessageId!;

    const res = await processDeliveryStatuses(admin, {
      tenantId: tenant,
      statuses: [
        { providerMessageId: wamid, status: 'delivered', cost: { category: 'service' } },
        { providerMessageId: wamid, status: 'read' },
        { providerMessageId: 'wamid.ajeno', status: 'read' },
      ],
    });
    expect(res.applied).toBe(2);
    const fila = await admin.query('SELECT delivery_status, meta FROM messages WHERE id = $1', [messageId]);
    expect(fila.rows[0].delivery_status).toBe('read');
    expect(fila.rows[0].meta.costo).toMatchObject({ category: 'service' });

    // failed con código de Meta → causa en español para la bandeja.
    const fallado = await nuevoSaliente();
    const conWamid = await processOutbound(admin, redis, jobPara(fallado) as never);
    await processDeliveryStatuses(admin, {
      tenantId: tenant,
      statuses: [
        { providerMessageId: conWamid.providerMessageId!, status: 'failed', errorCode: 131026 },
      ],
    });
    const filaFallada = await admin.query('SELECT delivery_status, meta FROM messages WHERE id = $1', [fallado]);
    expect(filaFallada.rows[0].delivery_status).toBe('failed');
    expect(filaFallada.rows[0].meta.error).toBe('El número no tiene WhatsApp.');
  });
});
