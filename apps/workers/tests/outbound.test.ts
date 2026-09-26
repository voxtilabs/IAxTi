import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { OutboundJobData } from '@iaxti/module-whatsapp';
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
    // 503 y no 400 a propósito (#556): este caso prueba el camino
    // TRANSITORIO, y un 400 hoy es permanente — lo clasifica el adaptador.
    if (modo === 'fallo') throw new Error('WhatsApp no aceptó el envío: HTTP 503');
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

// El `extra` era `Record<string, unknown>` y cada llamada iba con `as never`:
// así se podía armar un job SIN `initiatedByBusiness`, que en `OutboundJobData`
// es obligatorio justamente porque olvidarlo hacía salir una automatización a
// las 3 de la mañana (#372). El helper de la prueba podía construir la forma
// que el producto se ocupó de volver imposible. Ahora cada llamada dice qué
// tipo de envío es, que además es de lo que tratan varias de estas pruebas.
function jobPara(
  messageId: string,
  extra: Partial<OutboundJobData> & Pick<OutboundJobData, 'initiatedByBusiness'>,
  attemptsMade = 0,
) {
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
    const res = await processOutbound(admin, redis, jobPara(messageId, { initiatedByBusiness: false }));
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
      processOutbound(admin, redis, jobPara(messageId, { initiatedByBusiness: false }, 0)),
    ).rejects.toThrow(/HTTP 503/);

    const final = await processOutbound(admin, redis, jobPara(messageId, { initiatedByBusiness: false }, 4));
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
      processOutbound(admin, redis, jobPara(iniciado, { initiatedByBusiness: true })),
    ).rejects.toThrow(DelayUntilError);

    const respuesta = await nuevoSaliente();
    const res = await processOutbound(admin, redis, jobPara(respuesta, { initiatedByBusiness: false }));
    expect(res.providerMessageId).toBeTruthy(); // la respuesta salió igual
    await admin.query(`UPDATE tenants SET settings = '{}'::jsonb WHERE id = $1`, [tenant]);
  });

  it('el comprobante de pago NO espera: es transaccional (ADR-0016)', async () => {
    await admin.query(
      `UPDATE tenants SET settings = settings || '{"bandeja":{"silencio":{"desde":"00:00","hasta":"23:59","zona":"America/Santiago"}}}'::jsonb
       WHERE id = $1`,
      [tenant],
    );
    const comprobante = await nuevoSaliente();
    // Lo dispara el cliente al pagar y es la constancia de eso. Quien acaba
    // de pagar está despierto; un comprobante que llega doce horas después
    // ya no tranquiliza a nadie.
    const res = await processOutbound(
      admin,
      redis,
      jobPara(comprobante, { initiatedByBusiness: true, transaccional: true }),
    );
    expect(res.providerMessageId).toBeTruthy();
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
        // `senderId` es obligatorio desde ADR-0014: sin él quedaba una fila con
        // sender_id NULL, que es la forma VIEJA (Meta directo) y la que el
        // producto ya no puede crear. La prueba corría sobre una fila que
        // producción no produce.
        senderId: 'sender-out-quality',
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
    const res = await processOutbound(admin, redis, jobPara(iniciado, { initiatedByBusiness: true }));
    expect(res.failed).toMatch(/pausamos los envíos/);
    const fila = await admin.query('SELECT delivery_status FROM messages WHERE id = $1', [iniciado]);
    expect(fila.rows[0].delivery_status).toBe('failed');

    const respuesta = await nuevoSaliente();
    const ok = await processOutbound(admin, redis, jobPara(respuesta, { initiatedByBusiness: false }));
    expect(ok.providerMessageId).toBeTruthy(); // responder nunca se pausa
  });
});

describe('estados del webhook (#43)', () => {
  it('delivered y read con costo quedan en el mensaje; failed trae causa legible', async () => {
    modo = 'ok';
    const messageId = await nuevoSaliente();
    const enviado = await processOutbound(admin, redis, jobPara(messageId, { initiatedByBusiness: false }));
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
    const conWamid = await processOutbound(admin, redis, jobPara(fallado, { initiatedByBusiness: false }));
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

  it('impago: en solo lectura salen las respuestas manuales, NO lo del negocio', async () => {
    // El estado se escribe a mano: la máquina de dominio ya está probada
    // en organizations, acá lo que importa es que alguien la OBEDEZCA.
    await admin.query("UPDATE tenants SET state = 'read_only' WHERE id = $1", [tenant]);

    const delNegocio = await nuevoSaliente();
    const frenado = await processOutbound(admin, redis, jobPara(delNegocio, { initiatedByBusiness: true }));
    expect(frenado.failed).toContain('solo lectura');
    const estado = await admin.query('SELECT delivery_status, meta FROM messages WHERE id = $1', [delNegocio]);
    expect(estado.rows[0].delivery_status).toBe('failed');
    expect(JSON.stringify(estado.rows[0].meta)).toContain('respuestas manuales');

    // Una persona respondiendo en la bandeja sí sale: la bandeja no se corta.
    const manual = await nuevoSaliente();
    const salio = await processOutbound(admin, redis, jobPara(manual, { initiatedByBusiness: false }));
    expect(salio.providerMessageId).toMatch(/^wamid\./);

    // Suspendida no sale nada, ni siquiera lo manual.
    await admin.query("UPDATE tenants SET state = 'suspended' WHERE id = $1", [tenant]);
    const otro = await nuevoSaliente();
    const nada = await processOutbound(admin, redis, jobPara(otro, { initiatedByBusiness: false }));
    expect(nada.failed).toContain('suspendida');

    await admin.query("UPDATE tenants SET state = 'active' WHERE id = $1", [tenant]);
  });
});
