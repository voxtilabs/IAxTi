import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { DEFAULT_SILENCIO, enSilencio, msHastaFinDeSilencio } from '../domain/horario';
import {
  receiveInbound,
  sendMessage,
  updateDeliveryStatus,
  updateDeliveryStatusByProviderId,
} from '../application/conversations';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let mensaje: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('salida-test') RETURNING id");
  tenant = t.rows[0].id;
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, phone: '+56941110001', channel: 'simulador', body: 'hola' }),
  );
  const out = await withTenant(admin, tenant, (c) =>
    sendMessage(c, {
      tenantId: tenant,
      conversationId: res.conversation.id,
      authorKind: 'user',
      body: 'respuesta',
    }),
  );
  mensaje = out.id;
  await withTenant(admin, tenant, (c) =>
    updateDeliveryStatus(c, { tenantId: tenant, messageId: mensaje, status: 'sent', providerMessageId: 'wamid.s1' }),
  );
});

afterAll(async () => {
  await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('horario de silencio (dominio, #43)', () => {
  // Junio: Chile en UTC-4 estable.
  it('cruza la medianoche y calcula cuánto falta para el fin', () => {
    const nochePlena = new Date('2026-06-03T03:00:00Z'); // 23:00 en Chile
    const madrugada = new Date('2026-06-03T10:30:00Z'); // 06:30
    const mediodia = new Date('2026-06-03T16:00:00Z'); // 12:00
    expect(enSilencio(DEFAULT_SILENCIO, nochePlena)).toBe(true);
    expect(enSilencio(DEFAULT_SILENCIO, madrugada)).toBe(true);
    expect(enSilencio(DEFAULT_SILENCIO, mediodia)).toBe(false);
    expect(msHastaFinDeSilencio(DEFAULT_SILENCIO, madrugada)).toBe(90 * 60_000); // hasta las 08:00
    expect(msHastaFinDeSilencio(DEFAULT_SILENCIO, mediodia)).toBe(0);
  });
});

describe('estados por id del proveedor (#43)', () => {
  it('avanza la entrega, guarda el costo de Meta y publica los eventos', async () => {
    const actualizado = await withTenant(admin, tenant, (c) =>
      updateDeliveryStatusByProviderId(c, {
        tenantId: tenant,
        providerMessageId: 'wamid.s1',
        status: 'delivered',
        cost: { billable: true, category: 'service', pricing_model: 'CBP' },
      }),
    );
    expect(actualizado?.deliveryStatus).toBe('delivered');
    const meta = await admin.query('SELECT meta FROM messages WHERE id = $1', [mensaje]);
    expect(meta.rows[0].meta.costo).toMatchObject({ category: 'service' });
  });

  it('la regresión y el wamid desconocido se ignoran sin llorar (Meta reenvía)', async () => {
    const regresion = await withTenant(admin, tenant, (c) =>
      updateDeliveryStatusByProviderId(c, {
        tenantId: tenant,
        providerMessageId: 'wamid.s1',
        status: 'sent', // ya está delivered: no retrocede
      }),
    );
    expect(regresion).toBeNull();
    const desconocido = await withTenant(admin, tenant, (c) =>
      updateDeliveryStatusByProviderId(c, {
        tenantId: tenant,
        providerMessageId: 'wamid.nunca-visto',
        status: 'read',
      }),
    );
    expect(desconocido).toBeNull();
  });
});
