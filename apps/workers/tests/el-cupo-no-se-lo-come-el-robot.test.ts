import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type IORedis from 'ioredis';
import type { OutboundJobData } from '@iaxti/module-whatsapp';
import { createPool, runMigrations, sinTriggers, withTenant } from '@iaxti/db';
import { redisConnection } from '@iaxti/core';
import { receiveInbound, sendMessage } from '@iaxti/module-conversations';
import {
  createChannelAccount,
  registerProvider,
  resetProviders,
  setChannelState,
} from '@iaxti/module-channels';
import type { ChannelProvider } from '@iaxti/module-channels';
import { DelayUntilError, processOutbound } from '../src/outbound';

/**
 * El cupo del canal no se lo come el automatismo (#1248).
 *
 * Tech AI Summit, 3 de noviembre: el pulso del evento mandó 182 mensajes sobre
 * 91 entrantes, y al cerrar el stand los 31 de despedida fallaron TODOS con «el
 * canal llegó a su tope diario». El tope es del canal entero — ni un mensaje de
 * servicio dentro de la ventana de 24 h pasa.
 *
 * Lo que esto fija es la asimetría, que es el arreglo: con el cupo casi
 * gastado, lo que empieza el negocio se DIFIERE y lo que manda una persona
 * SALE. No se pierde nada: un diferido sale cuando el proveedor reinicia el
 * cupo, que es lo que el mensaje del pulso podía esperar y el de despedida no.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let redis: IORedis;
let tenant: string;
let conversacion: string;
let account: string;

const fakeProvider: ChannelProvider = {
  kind: 'whatsapp',
  async send() {
    return { providerMessageId: `wamid.cupo-${Math.random().toString(36).slice(2, 8)}` };
  },
  verifyWebhook: () => true,
  normalize: () => [],
};

function jobPara(
  messageId: string,
  extra: Partial<OutboundJobData> & Pick<OutboundJobData, 'initiatedByBusiness'>,
) {
  return {
    attemptsMade: 0,
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

/**
 * Deja `n` salientes ya ACEPTADOS por el proveedor en el día del cupo.
 *
 * Con `provider_message_id`, que es lo que cuenta `salientesDelDia`: un
 * mensaje que falló o que sigue en la cola no gastó cupo.
 */
async function yaSeGastaron(n: number): Promise<void> {
  await admin.query(
    // El canal sale de la conversación: `messages` no tiene
    // `channel_account_id`, y suponerlo fue lo primero que esta prueba cazó.
    `INSERT INTO messages
       (tenant_id, conversation_id, direction, type, body,
        author_kind, provider_message_id, delivery_status)
     SELECT $1, $2, 'out', 'texto', 'gastado', 'system',
            'wamid.gastado-' || g, 'sent'
       FROM generate_series(1, $3) AS g`,
    [tenant, conversacion, n],
  );
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  redis = redisConnection();
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('cupo-del-robot') RETURNING id"))
    .rows[0].id;

  resetProviders();
  registerProvider(fakeProvider);
  process.env.FAKE_WA_KEY = 'clave';

  const cuenta = await withTenant(admin, tenant, (c) =>
    createChannelAccount(c, {
      tenantId: tenant,
      kind: 'whatsapp',
      name: 'Falso',
      credentialRef: 'FAKE_WA_KEY',
      config: { phoneNumberId: 'pn-cupo' },
    }),
  );
  account = cuenta.id;
  await withTenant(admin, tenant, (c) =>
    setChannelState(c, { tenantId: tenant, accountId: account, state: 'active' }),
  );

  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: '+56942229001',
      channel: 'whatsapp',
      channelAccountId: account,
      body: 'hola',
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
  await sinTriggers(admin, (c) => c.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]));
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('el cupo del canal no se lo come el automatismo (#1248)', () => {
  it('con el cupo casi gastado, lo que empieza el negocio se difiere', async () => {
    // 200 de 250: queda el margen reservado a las personas y nada más.
    await yaSeGastaron(200);
    const id = await nuevoSaliente();
    await expect(
      processOutbound(admin, redis, jobPara(id, { initiatedByBusiness: true })),
    ).rejects.toThrow(DelayUntilError);
  });

  it('y el mensaje de una PERSONA sale igual, que es el arreglo entero', async () => {
    // Mismo cupo, mismo canal, mismo instante. Lo único distinto es quién lo
    // empieza — y es lo que separó el mensaje de despedida del del pulso.
    const id = await nuevoSaliente();
    const res = await processOutbound(admin, redis, jobPara(id, { initiatedByBusiness: false }));
    expect(res.providerMessageId).toMatch(/^wamid\./);
  });

  it('un transaccional del negocio también sale: lo dispara el cliente al pagar', async () => {
    const id = await nuevoSaliente();
    const res = await processOutbound(
      admin,
      redis,
      jobPara(id, { initiatedByBusiness: true, transaccional: true }),
    );
    expect(res.providerMessageId).toMatch(/^wamid\./);
  });

  it('con el tope configurado más alto, el automatismo pasa', async () => {
    // El mismo gasto que arriba, pero el canal declara 1000: 200 usados dejan
    // 750 para automatismos. Sin leer la configuración, este caso se diferiría
    // igual y una campaña legítima «no funcionaría» sin explicación.
    await admin.query(
      `UPDATE channel_accounts SET config = config || '{"topeDiario": 1000}'::jsonb
        WHERE tenant_id = $1 AND id = $2`,
      [tenant, account],
    );
    const id = await nuevoSaliente();
    const res = await processOutbound(admin, redis, jobPara(id, { initiatedByBusiness: true }));
    expect(res.providerMessageId).toMatch(/^wamid\./);
  });
});
