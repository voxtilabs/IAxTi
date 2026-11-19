import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, sinTriggers, withTenant } from '@iaxti/db';
import {
  applyQualityUpdate,
  isBusinessPaused,
  numeroEnRojo,
  resumeBusinessSends,
} from '../application/quality';
import { connectWhatsAppNumber } from '../application/numbers';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let numero: string;
let cuenta: string;
// Un tenant aparte con un número EXACTAMENTE como lo deja el alta del
// proveedor (Zernio): con sender_id y con phone_number_id en NULL, que es lo
// que hacía inútil la búsqueda vieja. El parser de eventos de calidad se fue
// con Zavu (#1339); el freno que aplica estos avisos sigue enchufado a mano.
let tenantSinIdsDeMeta: string;
let cuentaSinIdsDeMeta: string;

async function eventos(nombre: string, deTenant = tenant): Promise<number> {
  const r = await admin.query(
    'SELECT count(*)::int AS n FROM outbox WHERE name = $1 AND tenant_id = $2',
    [nombre, deTenant],
  );
  return r.rows[0].n;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('quality-test') RETURNING id");
  tenant = t.rows[0].id;
  await admin.query("UPDATE tenants SET plan = 'crece' WHERE id = $1", [tenant]);
  const res = await withTenant(admin, tenant, (c) =>
    connectWhatsAppNumber(c, {
      tenantId: tenant,
      name: 'Calidad',
      // `senderId` es obligatorio desde ADR-0014: sin él la fila quedaba con
      // sender_id NULL, la forma vieja que el producto ya no puede crear.
      senderId: 'sender-quality-test',
      phoneNumberId: 'pn-quality-1',
      credentialRef: 'X',
      webhookSecretRef: 'Y',
    }),
  );
  numero = res.number.id;
  cuenta = res.account.id;

  const t2 = await admin.query(
    "INSERT INTO tenants (name) VALUES ('quality-test-sin-meta') RETURNING id",
  );
  tenantSinIdsDeMeta = t2.rows[0].id;
  await admin.query("UPDATE tenants SET plan = 'crece' WHERE id = $1", [tenantSinIdsDeMeta]);
  const sinMeta = await withTenant(admin, tenantSinIdsDeMeta, (c) =>
    connectWhatsAppNumber(c, {
      tenantId: tenantSinIdsDeMeta,
      name: 'Calidad sin ids de Meta',
      // Sin phoneNumberId a propósito: es lo que produce el alta del proveedor
      // (zernio-perfil.ts no lo llena), y por eso la búsqueda por
      // phone_number_id no encontraba nada.
      senderId: 'snd_calidad_sin_meta',
      credentialRef: 'X',
      webhookSecretRef: 'Y',
    }),
  );
  cuentaSinIdsDeMeta = sinMeta.account.id;
});

afterAll(async () => {
  for (const t of [tenant, tenantSinIdsDeMeta]) {
    if (!t) continue;
    await admin.query('DELETE FROM whatsapp_numbers WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [t]);
    await sinTriggers(admin, (c) => c.query('DELETE FROM audit_log WHERE tenant_id = $1', [t]));
    await admin.query('DELETE FROM tenants WHERE id = $1', [t]);
  }
  await admin.end();
});

describe('calidad del número (#45)', () => {
  // El parser de eventos de calidad (normalizeQualityUpdates) se fue con Zavu
  // (#1339): Zernio todavía no publica el evento. Lo que sigue vivo es el
  // freno: aplicar un aviso ya traducido, pausar en rojo y reactivar a mano.

  // Este número tiene los DOS identificadores, así que prueba el respaldo por
  // phone_number_id: filas antiguas de Meta directo y el proveedor propio (#82).
  it('en ROJO pausa lo del negocio, degrada el canal y publica los eventos', async () => {
    const res = await withTenant(admin, tenant, (c) =>
      applyQualityUpdate(c, {
        tenantId: tenant,
        update: { phoneNumberId: 'pn-quality-1', quality: 'red', messagingLimit: 'TIER_250' },
      }),
    );
    expect(res).toEqual({ changed: true, pausado: true });
    expect(await eventos('number.quality_changed')).toBe(1);
    expect(await eventos('channel.degraded')).toBe(1);

    const pausa = await withTenant(admin, tenant, (c) => isBusinessPaused(c, tenant, cuenta));
    expect(pausa).toMatch(/pausamos los envíos/);
    const canal = await admin.query('SELECT state FROM channel_accounts WHERE id = $1', [cuenta]);
    expect(canal.rows[0].state).toBe('degraded');
  });

  it('volver a green NO reactiva solo; reactivar en rojo se rechaza; el ADMIN reactiva', async () => {
    // Con la calidad aún en rojo, reactivar se niega con explicación.
    await expect(
      withTenant(admin, tenant, (c) => resumeBusinessSends(c, { tenantId: tenant, numberId: numero })),
    ).rejects.toThrow(/sigue en rojo/);

    await withTenant(admin, tenant, (c) =>
      applyQualityUpdate(c, { tenantId: tenant, update: { phoneNumberId: 'pn-quality-1', quality: 'green' } }),
    );
    // Sigue pausado: nada se dispara solo.
    expect(await withTenant(admin, tenant, (c) => isBusinessPaused(c, tenant, cuenta))).not.toBeNull();

    await withTenant(admin, tenant, (c) => resumeBusinessSends(c, { tenantId: tenant, numberId: numero }));
    expect(await withTenant(admin, tenant, (c) => isBusinessPaused(c, tenant, cuenta))).toBeNull();
    const canal = await admin.query('SELECT state FROM channel_accounts WHERE id = $1', [cuenta]);
    expect(canal.rows[0].state).toBe('active');
  });

  it('un update sin cambios reales no publica nada', async () => {
    const antes = await eventos('number.quality_changed');
    const res = await withTenant(admin, tenant, (c) =>
      applyQualityUpdate(c, { tenantId: tenant, update: { phoneNumberId: 'pn-quality-1', quality: 'green' } }),
    );
    expect(res.changed).toBe(false);
    expect(await eventos('number.quality_changed')).toBe(antes);
  });
});

// La identidad del número de WhatsApp es el senderId (ADR-0014, y el alta de
// Zernio igual: no llena phone_number_id). Con esa forma de fila, la búsqueda
// vieja por phone_number_id no encontraba fila NUNCA: el freno del #45 salía
// en silencio con changed:false aunque el aviso llegara perfecto.
describe('calidad del número: identidad por senderId (#45, ADR-0014)', () => {
  it('la fila que crea el alta NO tiene phone_number_id: esa es la premisa', async () => {
    const fila = await admin.query(
      'SELECT sender_id, phone_number_id FROM whatsapp_numbers WHERE tenant_id = $1',
      [tenantSinIdsDeMeta],
    );
    expect(fila.rows[0].sender_id).toBe('snd_calidad_sin_meta');
    expect(fila.rows[0].phone_number_id).toBeNull();
  });

  it('en ROJO por senderId: pausa lo del negocio, degrada el canal y avisa', async () => {
    const res = await withTenant(admin, tenantSinIdsDeMeta, (c) =>
      applyQualityUpdate(c, {
        tenantId: tenantSinIdsDeMeta,
        update: { senderId: 'snd_calidad_sin_meta', quality: 'red', messagingLimit: 'TIER_1K' },
      }),
    );
    expect(res).toEqual({ changed: true, pausado: true });
    expect(await eventos('number.quality_changed', tenantSinIdsDeMeta)).toBe(1);
    expect(await eventos('channel.degraded', tenantSinIdsDeMeta)).toBe(1);

    const pausa = await withTenant(admin, tenantSinIdsDeMeta, (c) =>
      isBusinessPaused(c, tenantSinIdsDeMeta, cuentaSinIdsDeMeta),
    );
    expect(pausa).toMatch(/pausamos los envíos/);
    const canal = await admin.query('SELECT state FROM channel_accounts WHERE id = $1', [
      cuentaSinIdsDeMeta,
    ]);
    expect(canal.rows[0].state).toBe('degraded');
    // Y la campaña (#75) ya lo ve: el número quedó en rojo de verdad, en la base.
    expect(await withTenant(admin, tenantSinIdsDeMeta, (c) => numeroEnRojo(c, tenantSinIdsDeMeta))).toBe(true);
  });

  it('el senderId de otro tenant no toca este número', async () => {
    // El aviso trae un sender que no es de este tenant: no hay nada que aplicar,
    // y sobre todo no se agarra la primera fila que aparezca.
    const res = await withTenant(admin, tenantSinIdsDeMeta, (c) =>
      applyQualityUpdate(c, {
        tenantId: tenantSinIdsDeMeta,
        update: { senderId: 'sender-quality-test', quality: 'green' },
      }),
    );
    expect(res).toEqual({ changed: false, pausado: false });
  });

  it('un cambio sin senderId ni phoneNumberId se rechaza diciendo por qué', async () => {
    // Antes esto consultaba `phone_number_id = NULL`, no encontraba nada y
    // devolvía changed:false: un error de quien encola disfrazado de "no pasó
    // nada". Si no sabemos de qué número habla, se dice fuerte.
    await expect(
      withTenant(admin, tenantSinIdsDeMeta, (c) =>
        applyQualityUpdate(c, { tenantId: tenantSinIdsDeMeta, update: { quality: 'red' } }),
      ),
    ).rejects.toThrow(/no dice de qué número habla/);
  });
});
