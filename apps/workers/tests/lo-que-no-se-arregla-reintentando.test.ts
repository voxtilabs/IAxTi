import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { OutboundJobData } from '@iaxti/module-whatsapp';
import { ErrorPermanente } from '@iaxti/module-whatsapp';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { redisConnection } from '@iaxti/core';
import type IORedis from 'ioredis';
import { receiveInbound, sendMessage } from '@iaxti/module-conversations';
import {
  createChannelAccount,
  registerProvider,
  resetProviders,
  setChannelState,
} from '@iaxti/module-channels';
import type { ChannelProvider } from '@iaxti/module-channels';
import { processOutbound } from '../src/outbound';

/**
 * Lo permanente se rechaza al PRIMER intento; lo transitorio sigue
 * reintentando (#556).
 *
 * Antes, todo lo que no fuera rate limit se reencolaba: cinco intentos con
 * backoff exponencial para una variable de entorno ausente o un emisor sin
 * asignar, que no aparecen solos. El mensaje se quedaba «enviando» varias
 * horas y recién al final contaba qué pasó — con el texto crudo del sistema,
 * «La cuenta de canal no tiene senderId».
 *
 * Quién decide es el ADAPTADOR y no el worker, y es a propósito: solo el
 * adaptador sabe qué significó ese 400. El worker únicamente distingue la
 * clase del error. Por eso el proveedor falso de acá lanza las dos.
 */

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let redis: IORedis;
let tenant: string;
let conversacion: string;
let account: string;
let modo: 'permanente' | 'transitorio' = 'permanente';

const fakeProvider: ChannelProvider = {
  kind: 'whatsapp',
  async send() {
    if (modo === 'permanente') {
      throw new ErrorPermanente(
        'Este canal no tiene un emisor asignado. Reconéctalo en Canales para elegir el número que envía.',
        'La cuenta xxx no trae config.senderId (ADR-0014).',
      );
    }
    throw new Error('El canal no aceptó el envío: HTTP 503');
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

function jobPara(messageId: string, attemptsMade = 0) {
  return {
    attemptsMade,
    opts: { attempts: 5 },
    data: {
      moduleId: 'whatsapp' as const,
      tenantId: tenant,
      messageId,
      channelAccountId: account,
      to: '',
      initiatedByBusiness: false,
    } satisfies OutboundJobData,
  };
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  redis = redisConnection();
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('permanente-test') RETURNING id");
  tenant = t.rows[0].id;

  resetProviders();
  registerProvider(fakeProvider);
  process.env.FAKE_PERM_KEY = 'clave';

  const cuenta = await withTenant(admin, tenant, (c) =>
    createChannelAccount(c, {
      tenantId: tenant,
      kind: 'whatsapp',
      name: 'Falso',
      credentialRef: 'FAKE_PERM_KEY',
      config: { phoneNumberId: 'pn-perm-test' },
    }),
  );
  account = cuenta.id;
  await withTenant(admin, tenant, (c) =>
    setChannelState(c, { tenantId: tenant, accountId: account, state: 'active' }),
  );
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: '+56942220777',
      channel: 'whatsapp',
      channelAccountId: account,
      body: 'hola',
    }),
  );
  conversacion = res.conversation.id;
});

afterAll(async () => {
  resetProviders();
  delete process.env.FAKE_PERM_KEY;
  await redis.quit();
  for (const tabla of [
    'messages', 'conversations', 'contacts', 'whatsapp_numbers', 'channel_accounts', 'outbox',
  ]) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('lo permanente no se reintenta (#556)', () => {
  it('un canal mal configurado falla en el PRIMER intento, no en el quinto', async () => {
    modo = 'permanente';
    const messageId = await nuevoSaliente();
    // attemptsMade 0 con attempts 5: antes esto relanzaba y el mensaje se
    // quedaba en la cola. Ahora no hay reintento que sirva y se dice al tiro.
    const res = await processOutbound(admin, redis, jobPara(messageId, 0));
    expect(res.failed).toBeTruthy();
    const fila = await admin.query('SELECT delivery_status, meta FROM messages WHERE id = $1', [
      messageId,
    ]);
    expect(fila.rows[0].delivery_status).toBe('failed');
  });

  it('lo que lee una persona dice qué hacer, y no menciona ningún campo interno', async () => {
    modo = 'permanente';
    const messageId = await nuevoSaliente();
    await processOutbound(admin, redis, jobPara(messageId, 0));
    const fila = await admin.query('SELECT meta FROM messages WHERE id = $1', [messageId]);
    const error = String(fila.rows[0].meta.error);
    expect(error).toMatch(/Reconéctalo en Canales/);
    // El detalle técnico va al log, no a la bandeja: el vendedor no tiene por
    // qué leer «senderId» ni un ADR para entender que el canal está mal.
    expect(error).not.toMatch(/senderId|config\.|ADR-/);
    expect(error).not.toMatch(/HTTP \d/);
  });

  it('lo transitorio SIGUE reintentando y no se marca failed antes de tiempo', async () => {
    modo = 'transitorio';
    const messageId = await nuevoSaliente();
    await expect(processOutbound(admin, redis, jobPara(messageId, 0))).rejects.toThrow(/HTTP 503/);
    const fila = await admin.query('SELECT delivery_status FROM messages WHERE id = $1', [messageId]);
    // Sigue en cola: un 503 se arregla esperando, y darlo por perdido al
    // primer intento perdería mensajes que iban a salir bien.
    expect(fila.rows[0].delivery_status).toBe('queued');

    const final = await processOutbound(admin, redis, jobPara(messageId, 4));
    expect(final.failed).toBeTruthy();
  });
});
