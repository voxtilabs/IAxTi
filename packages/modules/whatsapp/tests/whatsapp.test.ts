import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createKapsoProvider, normalizeStatuses } from '../application/kapso';
import { RateLimitedError, causaLegible, checkNumberRateLimit } from '../application/outbound';
import { redisConnection } from '@iaxti/core';
import { downloadAttachmentsToR2 } from '../application/media';
import {
  connectWhatsAppNumber,
  findNumberByPhoneNumberId,
  listWhatsAppNumbers,
} from '../application/numbers';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenant: string;

// Payload REAL de la Cloud API (la forma que Kapso espeja).
const WEBHOOK_META = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba-1',
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { display_phone_number: '56912345678', phone_number_id: 'pn-123' },
            contacts: [{ profile: { name: 'María Paz' }, wa_id: '56987654321' }],
            messages: [
              {
                from: '56987654321',
                id: 'wamid.abc123',
                timestamp: '1757800000',
                type: 'text',
                text: { body: 'Hola, ¿tienen horas mañana?' },
              },
              {
                from: '56987654321',
                id: 'wamid.def456',
                timestamp: '1757800060',
                type: 'image',
                image: { id: 'media-789', mime_type: 'image/jpeg', caption: 'mi boleta' },
              },
            ],
          },
        },
      ],
    },
  ],
};

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

describe('adaptador Kapso (vocabulario Cloud API, #42)', () => {
  const provider = createKapsoProvider({ apiBase: 'https://kapso.test/meta' });

  it('normaliza el webhook de Meta: texto y adjunto con media id', () => {
    const msgs = provider.normalize(WEBHOOK_META);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({
      phone: '+56987654321',
      type: 'texto',
      body: 'Hola, ¿tienen horas mañana?',
      providerMessageId: 'wamid.abc123',
    });
    expect(msgs[1]).toMatchObject({
      phone: '+56987654321',
      type: 'imagen',
      body: 'mi boleta',
      providerMessageId: 'wamid.def456',
    });
    expect(msgs[1].attachments?.[0]).toMatchObject({ mediaId: 'media-789', contentType: 'image/jpeg' });
  });

  it('verifica X-Hub-Signature-256 con y sin prefijo sha256=', () => {
    const cuerpo = JSON.stringify(WEBHOOK_META);
    const hmac = createHmac('sha256', 'secreto').update(cuerpo).digest('hex');
    expect(provider.verifyWebhook({ 'x-hub-signature-256': `sha256=${hmac}` }, cuerpo, 'secreto')).toBe(true);
    expect(provider.verifyWebhook({ 'x-hub-signature-256': hmac }, cuerpo, 'secreto')).toBe(true);
    expect(provider.verifyWebhook({ 'x-hub-signature-256': `sha256=${hmac}` }, cuerpo, 'otro')).toBe(false);
  });

  it('send habla Cloud API tal cual y devuelve el wamid', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.out1' }] }),
    });
    const conFetch = createKapsoProvider({ apiBase: 'https://kapso.test/meta', fetchImpl: fetchMock });
    process.env.KAPSO_KEY_TEST = 'api-key-test';
    const res = await conFetch.send(
      {
        id: 'a1',
        tenantId: tenant,
        kind: 'whatsapp',
        name: 'n',
        state: 'active',
        credentialRef: 'KAPSO_KEY_TEST',
        config: { phoneNumberId: 'pn-123' },
      },
      { to: '+56987654321', type: 'texto', body: 'Hola' },
    );
    expect(res.providerMessageId).toBe('wamid.out1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://kapso.test/meta/pn-123/messages');
    expect(init.headers.Authorization).toBe('Bearer api-key-test');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '56987654321', type: 'text' });
    delete process.env.KAPSO_KEY_TEST;
  });
});

describe('números (rol de aplicación)', () => {
  it('conecta hasta el tope del plan y rechaza el número repetido', async () => {
    // El tenant nace en plan crece (trial): 2 números.
    const uno = await withTenant(app, tenant, (c) =>
      connectWhatsAppNumber(c, {
        tenantId: tenant,
        name: 'Número principal',
        phoneNumberId: 'pn-123',
        wabaId: 'waba-1',
        displayPhone: '+56 9 1234 5678',
        credentialRef: 'KAPSO_KEY_TEST',
        webhookSecretRef: 'KAPSO_WEBHOOK_SECRET',
      }),
    );
    expect(uno.account.state).toBe('active');
    expect(uno.number.phoneNumberId).toBe('pn-123');

    await expect(
      withTenant(app, tenant, (c) =>
        connectWhatsAppNumber(c, {
          tenantId: tenant,
          name: 'Repetido',
          phoneNumberId: 'pn-123',
          credentialRef: 'X',
          webhookSecretRef: 'Y',
        }),
      ),
    ).rejects.toThrow(/ya está conectado/);

    await withTenant(app, tenant, (c) =>
      connectWhatsAppNumber(c, {
        tenantId: tenant,
        name: 'Sucursal',
        phoneNumberId: 'pn-456',
        credentialRef: 'X',
        webhookSecretRef: 'Y',
      }),
    );
    await expect(
      withTenant(app, tenant, (c) =>
        connectWhatsAppNumber(c, {
          tenantId: tenant,
          name: 'Tercero',
          phoneNumberId: 'pn-789',
          credentialRef: 'X',
          webhookSecretRef: 'Y',
        }),
      ),
    ).rejects.toThrow(/Tu plan permite 2/);

    const lista = await withTenant(app, tenant, (c) => listWhatsAppNumbers(c, tenant));
    expect(lista).toHaveLength(2);
    const porId = await withTenant(admin, tenant, (c) => findNumberByPhoneNumberId(c, 'pn-123'));
    expect(porId?.tenantId).toBe(tenant);
  });
});

describe('adjuntos a R2 (#42)', () => {
  it('baja el media de Meta y lo sube al prefijo del tenant', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://meta.test/bin/1', mime_type: 'image/jpeg' }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8), headers: new Headers() })
      .mockResolvedValueOnce({ ok: true }); // PUT a R2
    const guardados = await downloadAttachmentsToR2(
      {
        tenantId: tenant,
        conversationId: 'whatsapp',
        attachments: [{ mediaId: 'media-789', contentType: 'image/jpeg', name: 'boleta.jpg' }],
        apiKey: 'api-key-test',
        storage: {
          endpoint: 'https://cuenta.r2.cloudflarestorage.com',
          bucket: 'adjuntos',
          accessKeyId: 'AK',
          secretAccessKey: 'SK',
        },
      },
      { apiBase: 'https://kapso.test/meta', fetchImpl: fetchMock },
    );
    expect(guardados).toHaveLength(1);
    expect(guardados[0].key.startsWith(`${tenant}/whatsapp/`)).toBe(true);
    expect(guardados[0].contentType).toBe('image/jpeg');
    // La subida fue un PUT prefirmado al bucket, bajo el prefijo del tenant.
    const [putUrl, putInit] = fetchMock.mock.calls[2];
    expect(putUrl).toContain('/adjuntos/');
    expect(putUrl).toContain(encodeURIComponent(tenant));
    expect(putInit.method).toBe('PUT');
  });
});

describe('salida (#43)', () => {
  it('normaliza los statuses del webhook y traduce los códigos de Meta', () => {
    const statuses = normalizeStatuses({
      entry: [{ changes: [{ value: { statuses: [
        { id: 'wamid.o1', status: 'delivered', pricing: { billable: true, category: 'service' } },
        { id: 'wamid.o2', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] },
        { id: 'wamid.o3', status: 'inventado' },
      ] } }] }],
    });
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({ providerMessageId: 'wamid.o1', status: 'delivered' });
    expect(statuses[0].cost).toMatchObject({ category: 'service' });
    expect(causaLegible(statuses[1].errorCode)).toBe('El número no tiene WhatsApp.');
    expect(causaLegible(999999, 'detalle crudo')).toBe('detalle crudo');
  });

  it('el rate limit por número corta la ráfaga y se reintenta solo', async () => {
    const redis = redisConnection();
    try {
      for (let i = 0; i < 3; i++) await checkNumberRateLimit(redis, 'pn-rate-test', 3);
      await expect(checkNumberRateLimit(redis, 'pn-rate-test', 3)).rejects.toThrow(RateLimitedError);
      // Otro número no comparte el cupo.
      await checkNumberRateLimit(redis, 'pn-otro', 3);
    } finally {
      await redis.quit();
    }
  });
});
