import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, sinTriggers, withTenant } from '@iaxti/db';
import { RateLimitedError, checkNumberRateLimit } from '../application/outbound';
import { redisConnection } from '@iaxti/core';
import { downloadAttachmentsToR2 } from '../application/media';
import {
  connectWhatsAppNumber,
  findNumberBySenderId,
  listWhatsAppNumbers,
} from '../application/numbers';

// Números, adjuntos y cupo por segundo del módulo whatsapp (#42, #43). El
// adaptador del proveedor tiene SU suite (el-adaptador-de-zernio); acá lo que
// queda es lo que vive contra la base y contra Redis, que es donde el producto
// decide cuántos números tiene un negocio y a qué ritmo salen.

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenant: string;

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
  await admin.query('GRANT SELECT, INSERT, UPDATE ON channel_accounts, channel_senders, whatsapp_numbers, plan_limits, tenants TO iaxti_app');
  // El rol puede nacer DESPUÉS de las migraciones en un CI virgen: sus
  // GRANT condicionales no sustituyen los permisos explícitos de la fixture.
  await admin.query('GRANT EXECUTE ON FUNCTION tenant_de_emisor_de_canal(text), tenant_del_emisor(text) TO iaxti_app');
  await admin.query('GRANT INSERT ON outbox TO iaxti_app');
  await admin.query('GRANT SELECT, INSERT ON audit_log TO iaxti_app');
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
  await sinTriggers(admin, (c) => c.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]));
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
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
        credentialRef: 'ZERNIO_LLAVE_1',
        webhookSecretRef: 'ZERNIO_WEBHOOK_SECRET_1',
      }),
    );
    expect(uno.account.state).toBe('active');
    expect(uno.number.senderId).toBe('snd-123');
    // Sin ids de Meta no pasa nada: el alta del proveedor no los llena, y la
    // identidad operativa es el emisor.
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
  it('baja el adjunto de la URL del proveedor y lo sube al prefijo del tenant', async () => {
    const fetchMock = vi.fn()
      // Las URLs de los adjuntos son firmadas y de vida corta: se bajan al
      // llegar, con la llave de la cuenta SOLO si van al dominio del proveedor
      // (#1335) — eso lo prueba la-llave-no-sale-del-proveedor.
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8), headers: new Headers({ 'content-type': 'image/jpeg' }) })
      .mockResolvedValueOnce({ ok: true }); // PUT a R2
    const guardados = await downloadAttachmentsToR2(
      {
        tenantId: tenant,
        conversationId: 'whatsapp',
        attachments: [
          { url: 'https://zernio.com/api/v1/whatsapp/media/boleta.jpg', contentType: 'image/jpeg', name: 'boleta.jpg' },
        ],
        apiKey: 'zrn_llave_de_prueba',
        storage: {
          endpoint: 'https://cuenta.r2.cloudflarestorage.com',
          bucket: 'adjuntos',
          accessKeyId: 'AK',
          secretAccessKey: 'SK',
        },
      },
      // La `apiBase` la trae quien llama desde la CUENTA (#1339): sin ella la
      // llave no viaja a ciegas, y la exigencia es parte de lo que se prueba.
      { fetchImpl: fetchMock, apiBase: 'https://zernio.com/api' },
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
  it('el rate limit por número corta la ráfaga y se reintenta solo', async () => {
    const redis = redisConnection();
    // Una ventana FIJA, y única para esta corrida: la ventana dura un
    // segundo, y confiar en que cuatro llamadas caigan todas en el mismo
    // ponía el test rojo cuando la máquina iba cargada — el contador se
    // reiniciaba a mitad de camino y el cupo no cortaba.
    const ventana = 1_700_000_000_000 + Math.floor(Math.random() * 1_000_000) * 1000;
    const numero = `snd-rate-${ventana}`;
    try {
      for (let i = 0; i < 3; i++) await checkNumberRateLimit(redis, numero, 3, ventana);
      await expect(checkNumberRateLimit(redis, numero, 3, ventana)).rejects.toThrow(RateLimitedError);
      // Otro número no comparte el cupo.
      await checkNumberRateLimit(redis, `${numero}-otro`, 3, ventana);
      // Y la ventana siguiente empieza de cero: el cupo es por segundo.
      await checkNumberRateLimit(redis, numero, 3, ventana + 1000);
    } finally {
      await redis.quit();
    }
  });
});
