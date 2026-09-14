import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  ZAVU_API_BASE_DEFAULT,
  createZavuProvider,
  normalizeStatuses,
  referralDe,
  verifyZavuSignature,
} from '../application/zavu';
import { RateLimitedError, causaLegible, checkNumberRateLimit } from '../application/outbound';
import { redisConnection } from '@iaxti/core';
import { downloadAttachmentsToR2 } from '../application/media';
import {
  connectWhatsAppNumber,
  findNumberBySenderId,
  listWhatsAppNumbers,
} from '../application/numbers';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenant: string;

// El envelope REAL de Zavu: un evento por entrega, `data` con el mensaje.
const AHORA_MS = 1757800000000;
const entrante = (data: Record<string, unknown>) => ({
  id: 'evt_1757800000000_abc123',
  type: 'message.inbound',
  timestamp: AHORA_MS,
  senderId: 'snd_abc123',
  projectId: 'prj_xyz789',
  data: {
    messageId: 'jd7x2k3m4n5p6q7r8s9t0',
    conversationId: null,
    from: '+56987654321',
    to: '+56912345678',
    channel: 'whatsapp',
    providerTimestamp: AHORA_MS,
    ...data,
  },
});

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
        CREATE ROLE iaxti_app LOGIN PASSWORD 'iaxti_app';
      END IF;
    END $$
  `);
  await admin.query('GRANT USAGE ON SCHEMA public TO iaxti_app');
  await admin.query('GRANT SELECT, INSERT, UPDATE ON channel_accounts, whatsapp_numbers, plan_limits, tenants TO iaxti_app');
  await admin.query('GRANT INSERT ON outbox TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('wsp-test') RETURNING id");
  tenant = t.rows[0].id;
  // Plan crece: 2 números (plan_limits); el INSERT crudo no pasa por createTenant.
  await admin.query("UPDATE tenants SET plan = 'crece' WHERE id = $1", [tenant]);
});

afterAll(async () => {
  await app.end();
  await admin.query('DELETE FROM whatsapp_numbers WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('adaptador Zavu (#42, ADR-0014)', () => {
  const provider = createZavuProvider('whatsapp', { apiBase: 'https://zavu.test/v1' });

  it('normaliza el entrante: texto y adjunto por URL', () => {
    const texto = provider.normalize(
      entrante({ messageType: 'text', text: 'Hola, ¿tienen horas mañana?' }),
    );
    expect(texto).toHaveLength(1);
    expect(texto[0]).toMatchObject({
      phone: '+56987654321',
      type: 'texto',
      body: 'Hola, ¿tienen horas mañana?',
      providerMessageId: 'jd7x2k3m4n5p6q7r8s9t0',
    });
    // El timestamp del proveedor manda y viaja en segundos.
    expect(texto[0].timestamp).toBe(String(AHORA_MS / 1000));

    const imagen = provider.normalize(
      entrante({
        messageId: 'msg-img',
        messageType: 'image',
        text: 'mi boleta',
        content: { mediaUrl: 'https://cdn.zavu.test/m/1.jpg', mimeType: 'image/jpeg' },
      }),
    );
    expect(imagen[0]).toMatchObject({ type: 'imagen', body: 'mi boleta' });
    expect(imagen[0].attachments?.[0]).toMatchObject({
      url: 'https://cdn.zavu.test/m/1.jpg',
      contentType: 'image/jpeg',
    });
  });

  it('un evento que no es entrante no produce mensajes', () => {
    // El tipo del evento es la verdad: `status` no distingue dirección, y un
    // saliente entregado también dice "delivered".
    expect(provider.normalize({ type: 'message.delivered', data: { messageId: 'x' } })).toHaveLength(0);
    expect(provider.normalize(entrante({ messageId: undefined }))).toHaveLength(0);
  });

  it('verifica la firma v2, acepta v1 y rechaza lo viejo o lo falso', () => {
    const cuerpo = JSON.stringify(entrante({ text: 'hola' }));
    const t = Math.floor(AHORA_MS / 1000);
    const reloj = () => AHORA_MS;
    const v2 = createHmac('sha256', 'secreto').update(`${t}.${cuerpo}`).digest('hex');
    const v1 = createHmac('sha256', 'secreto').update(cuerpo).digest('hex');

    expect(verifyZavuSignature(`t=${t},v2=${v2}`, cuerpo, 'secreto', reloj)).toBe(true);
    // Un sender viejo todavía firma v1: la misma implementación lo acepta.
    expect(verifyZavuSignature(`t=${t},v1=${v1}`, cuerpo, 'secreto', reloj)).toBe(true);
    // Con ambas presentes manda v2, que es la que cubre `{t}.{body}`.
    expect(verifyZavuSignature(`t=${t},v1=${v1},v2=${v2}`, cuerpo, 'secreto', reloj)).toBe(true);
    expect(verifyZavuSignature(`t=${t},v2=${v1}`, cuerpo, 'secreto', reloj)).toBe(false);
    expect(verifyZavuSignature(`t=${t},v2=${v2}`, cuerpo, 'otro', reloj)).toBe(false);
    // Fuera de la ventana de 5 minutos: una firma vieja es una repetición.
    expect(verifyZavuSignature(`t=${t},v2=${v2}`, cuerpo, 'secreto', () => AHORA_MS + 400_000)).toBe(false);
    expect(verifyZavuSignature(undefined, cuerpo, 'secreto', reloj)).toBe(false);
    expect(verifyZavuSignature(`v2=${v2}`, cuerpo, 'secreto', reloj)).toBe(false);
  });

  it('envía con el sender en la cabecera y devuelve el id del mensaje', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { id: 'msg_out1' } }),
    });
    const conFetch = createZavuProvider('whatsapp', {
      apiBase: 'https://zavu.test/v1',
      fetchImpl: fetchMock,
    });
    process.env.ZAVU_KEY_TEST = 'zv_test_key';
    const res = await conFetch.send(
      {
        id: 'a1',
        tenantId: tenant,
        kind: 'whatsapp',
        name: 'n',
        state: 'active',
        credentialRef: 'ZAVU_KEY_TEST',
        config: { senderId: 'snd_abc123' },
      },
      { to: '+56987654321', type: 'texto', body: 'Hola' },
    );
    expect(res.providerMessageId).toBe('msg_out1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://zavu.test/v1/messages');
    expect(init.headers.Authorization).toBe('Bearer zv_test_key');
    expect(init.headers['Zavu-Sender']).toBe('snd_abc123');
    // El destinatario va TAL CUAL: un BSUID de WhatsApp es opaco.
    expect(JSON.parse(init.body)).toMatchObject({
      to: '+56987654321',
      channel: 'whatsapp',
      text: 'Hola',
    });
    delete process.env.ZAVU_KEY_TEST;
  });

  it('el mismo adaptador sirve Instagram y Messenger, y nada más', async () => {
    expect(ZAVU_API_BASE_DEFAULT).toBe('https://api.zavu.dev/v1');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'm1' }) });
    process.env.ZAVU_KEY_TEST = 'zv_test_key';
    for (const kind of ['instagram', 'messenger'] as const) {
      const p = createZavuProvider(kind, { apiBase: 'https://zavu.test/v1', fetchImpl: fetchMock });
      expect(p.kind).toBe(kind);
      await p.send(
        {
          id: 'a1',
          tenantId: tenant,
          kind,
          name: 'n',
          state: 'active',
          credentialRef: 'ZAVU_KEY_TEST',
          config: { senderId: 'snd_ig' },
        },
        { to: '1234567890', type: 'texto', body: 'Hola' },
      );
      const [, init] = fetchMock.mock.calls.at(-1)!;
      expect(JSON.parse(init.body).channel).toBe(kind);
    }
    delete process.env.ZAVU_KEY_TEST;
    expect(() => createZavuProvider('webchat')).toThrow(/no transporta/);
  });

  it('el envío rechazado cuenta el motivo, no solo el número', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"error":{"code":"whatsapp_window_closed"}}',
    });
    process.env.ZAVU_KEY_TEST = 'zv_test_key';
    const p = createZavuProvider('whatsapp', { apiBase: 'https://zavu.test/v1', fetchImpl: fetchMock });
    await expect(
      p.send(
        {
          id: 'a1',
          tenantId: tenant,
          kind: 'whatsapp',
          name: 'n',
          state: 'active',
          credentialRef: 'ZAVU_KEY_TEST',
          config: { senderId: 'snd_abc123' },
        },
        { to: '+56987654321', type: 'texto', body: 'Hola' },
      ),
    ).rejects.toThrow(/whatsapp_window_closed/);
    delete process.env.ZAVU_KEY_TEST;
  });

  it('guarda el referral de click-to-WhatsApp, que llega una sola vez', () => {
    const conAnuncio = entrante({ referral: { ctwaClid: 'clid-1', sourceType: 'ad' } });
    expect(referralDe(conAnuncio)).toMatchObject({ ctwaClid: 'clid-1' });
    expect(referralDe(entrante({}))).toBeNull();
    expect(referralDe({ type: 'message.delivered', data: { referral: { ctwaClid: 'x' } } })).toBeNull();
  });
});

describe('números (rol de aplicación)', () => {
  it('conecta hasta el tope del plan y rechaza el sender repetido', async () => {
    // El tenant nace en plan crece (trial): 2 números.
    const uno = await withTenant(app, tenant, (c) =>
      connectWhatsAppNumber(c, {
        tenantId: tenant,
        name: 'Número principal',
        senderId: 'snd-123',
        displayPhone: '+56 9 1234 5678',
        credentialRef: 'ZAVU_API_KEY',
        webhookSecretRef: 'ZAVU_WEBHOOK_SECRET',
      }),
    );
    expect(uno.account.state).toBe('active');
    expect(uno.number.senderId).toBe('snd-123');
    // Sin ids de Meta no pasa nada: Zavu no los expone y ya no son obligatorios.
    expect(uno.number.phoneNumberId).toBeNull();

    await expect(
      withTenant(app, tenant, (c) =>
        connectWhatsAppNumber(c, {
          tenantId: tenant,
          name: 'Repetido',
          senderId: 'snd-123',
          credentialRef: 'X',
          webhookSecretRef: 'Y',
        }),
      ),
    ).rejects.toThrow(/ya está conectado/);

    await withTenant(app, tenant, (c) =>
      connectWhatsAppNumber(c, {
        tenantId: tenant,
        name: 'Sucursal',
        senderId: 'snd-456',
        credentialRef: 'X',
        webhookSecretRef: 'Y',
      }),
    );
    await expect(
      withTenant(app, tenant, (c) =>
        connectWhatsAppNumber(c, {
          tenantId: tenant,
          name: 'Tercero',
          senderId: 'snd-789',
          credentialRef: 'X',
          webhookSecretRef: 'Y',
        }),
      ),
    ).rejects.toThrow(/Tu plan permite 2/);

    const lista = await withTenant(app, tenant, (c) => listWhatsAppNumbers(c, tenant));
    expect(lista).toHaveLength(2);
    const porSender = await withTenant(admin, tenant, (c) => findNumberBySenderId(c, 'snd-123'));
    expect(porSender?.tenantId).toBe(tenant);
  });
});

describe('adjuntos a R2 (#42)', () => {
  it('baja el adjunto de la URL firmada y lo sube al prefijo del tenant', async () => {
    const fetchMock = vi.fn()
      // Las URLs de Zavu son firmadas y de vida corta: se bajan al llegar.
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8), headers: new Headers({ 'content-type': 'image/jpeg' }) })
      .mockResolvedValueOnce({ ok: true }); // PUT a R2
    const guardados = await downloadAttachmentsToR2(
      {
        tenantId: tenant,
        conversationId: 'whatsapp',
        attachments: [
          { url: 'https://cdn.zavu.test/m/boleta.jpg', contentType: 'image/jpeg', name: 'boleta.jpg' },
        ],
        apiKey: 'zv_test_key',
        storage: {
          endpoint: 'https://cuenta.r2.cloudflarestorage.com',
          bucket: 'adjuntos',
          accessKeyId: 'AK',
          secretAccessKey: 'SK',
        },
      },
      { fetchImpl: fetchMock },
    );
    expect(guardados).toHaveLength(1);
    expect(guardados[0].key.startsWith(`${tenant}/whatsapp/`)).toBe(true);
    expect(guardados[0].contentType).toBe('image/jpeg');
    // La subida fue un PUT prefirmado al bucket, bajo el prefijo del tenant.
    const [putUrl, putInit] = fetchMock.mock.calls[1];
    expect(putUrl).toContain('/adjuntos/');
    expect(putUrl).toContain(encodeURIComponent(tenant));
    expect(putInit.method).toBe('PUT');
  });
});

describe('salida (#43)', () => {
  it('el estado lo dice el tipo del evento, y el fallo se explica', () => {
    expect(normalizeStatuses({ type: 'message.delivered', data: { messageId: 'o1' } })).toMatchObject([
      { providerMessageId: 'o1', status: 'delivered' },
    ]);
    const fallido = normalizeStatuses({
      type: 'message.failed',
      data: { messageId: 'o2', errorCode: 'whatsapp_window_closed', errorMessage: 'window closed' },
    });
    expect(fallido[0]).toMatchObject({ providerMessageId: 'o2', status: 'failed' });
    expect(causaLegible(fallido[0].errorCode, fallido[0].errorDetail)).toMatch(/24 horas/);
    // Los códigos numéricos de Meta siguen traduciéndose cuando llegan.
    expect(causaLegible(131026)).toBe('El número no tiene WhatsApp.');
    expect(causaLegible(999999, 'detalle crudo')).toBe('detalle crudo');
    // Un evento que no es de entrega no ensucia la bandeja.
    expect(normalizeStatuses({ type: 'conversation.new', data: { messageId: 'o3' } })).toHaveLength(0);
  });

  it('el rate limit por número corta la ráfaga y se reintenta solo', async () => {
    const redis = redisConnection();
    try {
      for (let i = 0; i < 3; i++) await checkNumberRateLimit(redis, 'snd-rate-test', 3);
      await expect(checkNumberRateLimit(redis, 'snd-rate-test', 3)).rejects.toThrow(RateLimitedError);
      // Otro número no comparte el cupo.
      await checkNumberRateLimit(redis, 'snd-otro', 3);
    } finally {
      await redis.quit();
    }
  });
});
