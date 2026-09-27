import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound, sendMessage, updateDeliveryStatus } from '@iaxti/module-conversations';
import {
  createChannelAccount,
  registerProvider,
  resetProviders,
  setChannelState,
} from '@iaxti/module-channels';
import { RateLimitedError } from '@iaxti/module-whatsapp';
import { cerrarEnvioAbandonado, seDioPorVencida } from '../src/outbound';

/**
 * El mensaje que la cola abandonó no puede quedarse «enviando» para siempre.
 *
 * `processOutbound` cierra la fila en los caminos que conoce, pero el job muere
 * también por fuera de ellos: un `RateLimitedError` en el último intento (se
 * relanza SIEMPRE, incluso en el quinto), la base que no responde, R2 que no
 * firma el adjunto. En todos esos casos BullMQ manda el job a `failed` y nadie
 * tocaba la fila: quedaba en `queued`, y nada más vuelve a mirarla.
 *
 * Lo que ve el vendedor es un mensaje «enviando» meses después, sin saber si el
 * cliente lo recibió. La única salida que le queda es escribirlo de nuevo — que
 * duplica si en realidad sí había salido.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let conversacion: string;
let account: string;

function jobPara(
  messageId: string,
  opciones: { attemptsMade?: number; attempts?: number; finishedOn?: number } = {},
) {
  return {
    data: { moduleId: 'whatsapp', tenantId: tenant, messageId, requestId: 'req-abandonado' },
    attemptsMade: opciones.attemptsMade ?? 5,
    opts: { attempts: opciones.attempts ?? 5 },
    ...(opciones.finishedOn !== undefined ? { finishedOn: opciones.finishedOn } : {}),
  };
}

const estado = async (messageId: string) =>
  (await admin.query('SELECT delivery_status, meta FROM messages WHERE id = $1', [messageId]))
    .rows[0] as { delivery_status: string; meta: Record<string, unknown> };

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

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('abandonado-test') RETURNING id");
  tenant = t.rows[0].id;

  resetProviders();
  registerProvider({
    kind: 'whatsapp',
    send: async () => ({ providerMessageId: `wamid.abandonado-${Math.random().toString(36).slice(2, 8)}` }),
    verifyWebhook: () => true,
    normalize: () => [],
  });
  process.env.FAKE_ABANDONADO_KEY = 'clave';

  const cuenta = await withTenant(admin, tenant, (c) =>
    createChannelAccount(c, {
      tenantId: tenant,
      kind: 'whatsapp',
      name: 'Falso',
      credentialRef: 'FAKE_ABANDONADO_KEY',
      config: { phoneNumberId: 'pn-abandonado' },
    }),
  );
  account = cuenta.id;
  await withTenant(admin, tenant, (c) =>
    setChannelState(c, { tenantId: tenant, accountId: account, state: 'active' }),
  );
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: '+56942229999',
      channel: 'whatsapp',
      channelAccountId: account,
      body: 'hola',
    }),
  );
  conversacion = res.conversation.id;
});

afterAll(async () => {
  resetProviders();
  delete process.env.FAKE_ABANDONADO_KEY;
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('la cola se dio por vencida', () => {
  it('¿se agotaron los intentos?: solo cuando BullMQ ya no reintenta', () => {
    // El evento `failed` se emite en CADA intento. Marcar el mensaje en el
    // primero sería mentir: la cola todavía lo va a mandar.
    expect(seDioPorVencida({ data: {}, attemptsMade: 1, opts: { attempts: 5 } })).toBe(false);
    expect(seDioPorVencida({ data: {}, attemptsMade: 4, opts: { attempts: 5 } })).toBe(false);
    expect(seDioPorVencida({ data: {}, attemptsMade: 5, opts: { attempts: 5 } })).toBe(true);
    // `finishedOn` es la señal directa de BullMQ: lo escribe solo al mover el
    // job a `failed` de verdad (por ejemplo con un UnrecoverableError, que corta
    // los intentos antes de gastarlos todos).
    expect(
      seDioPorVencida({ data: {}, attemptsMade: 1, opts: { attempts: 5 }, finishedOn: 1 }),
    ).toBe(true);
  });

  it('el mensaje pasa a failed con una causa que dice qué hacer', async () => {
    const messageId = await nuevoSaliente();
    expect((await estado(messageId)).delivery_status).toBe('queued');

    const res = await cerrarEnvioAbandonado(admin, jobPara(messageId), new Error('la base no responde'));
    expect(res.marcado).toBe(true);

    const fila = await estado(messageId);
    expect(fila.delivery_status).toBe('failed');
    expect(String(fila.meta.error)).toMatch(/Vuelve a intentarlo/);
    // Ni una palabra del sistema en lo que lee una persona.
    expect(String(fila.meta.error)).not.toContain('la base no responde');
  });

  it('un rate limit agotado se cuenta como lo que es: el canal saturado', async () => {
    const messageId = await nuevoSaliente();
    await cerrarEnvioAbandonado(admin, jobPara(messageId), new RateLimitedError('pn-abandonado'));
    expect(String((await estado(messageId)).meta.error)).toMatch(/demasiados envíos/);
  });

  it('publica message.failed, que es lo que despierta al resto', async () => {
    const messageId = await nuevoSaliente();
    await cerrarEnvioAbandonado(admin, jobPara(messageId), new Error('se cayó'));
    const eventos = await admin.query(
      "SELECT payload FROM outbox WHERE tenant_id = $1 AND name = 'message.failed'",
      [tenant],
    );
    expect(eventos.rows.some((r) => r.payload.messageId === messageId)).toBe(true);
  });

  it('con intentos por delante NO toca nada: la cola todavía va a mandarlo', async () => {
    const messageId = await nuevoSaliente();
    const res = await cerrarEnvioAbandonado(
      admin,
      jobPara(messageId, { attemptsMade: 2 }),
      new Error('primer tropezón'),
    );
    expect(res.marcado).toBe(false);
    expect((await estado(messageId)).delivery_status).toBe('queued');
  });

  it('un mensaje que YA salió no se marca fallido (el job murió después del envío)', async () => {
    const messageId = await nuevoSaliente();
    await withTenant(admin, tenant, (c) =>
      updateDeliveryStatus(c, {
        tenantId: tenant,
        messageId,
        status: 'sent',
        providerMessageId: 'wamid.ya-salio',
      }),
    );
    const res = await cerrarEnvioAbandonado(admin, jobPara(messageId), new Error('cayó al guardar'));
    expect(res.marcado).toBe(false);
    expect((await estado(messageId)).delivery_status).toBe('sent');
  });

  it('es idempotente: dos avisos del mismo job no escriben dos veces', async () => {
    const messageId = await nuevoSaliente();
    expect((await cerrarEnvioAbandonado(admin, jobPara(messageId), new Error('x'))).marcado).toBe(true);
    expect((await cerrarEnvioAbandonado(admin, jobPara(messageId), new Error('x'))).marcado).toBe(false);
    expect((await estado(messageId)).delivery_status).toBe('failed');
  });

  it('un job sin mensaje identificable no revienta el proceso', async () => {
    expect(await cerrarEnvioAbandonado(admin, undefined, new Error('x'))).toEqual({ marcado: false });
    expect(
      await cerrarEnvioAbandonado(
        admin,
        { data: { tenantId: tenant }, attemptsMade: 5, opts: { attempts: 5 } },
        new Error('x'),
      ),
    ).toEqual({ marcado: false });
  });
});
