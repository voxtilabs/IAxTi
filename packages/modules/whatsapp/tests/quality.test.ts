import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  applyQualityUpdate,
  isBusinessPaused,
  normalizeQualityUpdates,
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
// Un tenant aparte con un número EXACTAMENTE como lo deja Zavu: con sender_id
// y con phone_number_id en NULL, que es lo que hacía inútil la búsqueda vieja.
let tenantZavu: string;
let cuentaZavu: string;

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
    "INSERT INTO tenants (name) VALUES ('quality-test-zavu') RETURNING id",
  );
  tenantZavu = t2.rows[0].id;
  await admin.query("UPDATE tenants SET plan = 'crece' WHERE id = $1", [tenantZavu]);
  const zavu = await withTenant(admin, tenantZavu, (c) =>
    connectWhatsAppNumber(c, {
      tenantId: tenantZavu,
      name: 'Calidad por Zavu',
      // Sin phoneNumberId a propósito: es lo que `conectarSender` produce, y
      // por eso la búsqueda por phone_number_id no encontraba nada.
      senderId: 'snd_calidad_zavu',
      credentialRef: 'X',
      webhookSecretRef: 'Y',
    }),
  );
  cuentaZavu = zavu.account.id;
});

afterAll(async () => {
  for (const t of [tenant, tenantZavu]) {
    if (!t) continue;
    await admin.query('DELETE FROM whatsapp_numbers WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM tenants WHERE id = $1', [t]);
  }
  await admin.end();
});

describe('calidad del número (#45)', () => {
  it('normaliza phone_number_quality_update por score o por evento', () => {
    const updates = normalizeQualityUpdates({
      entry: [{ changes: [
        {
          field: 'phone_number_quality_update',
          value: { phone_number_id: 'pn-1', event: 'FLAGGED', current_limit: 'TIER_250' },
        },
        {
          field: 'phone_number_quality_update',
          value: { phone_number_id: 'pn-2', quality_score: { score: 'GREEN' } },
        },
        { field: 'messages', value: {} },
      ] }],
    });
    expect(updates).toEqual([
      { phoneNumberId: 'pn-1', quality: 'red', messagingLimit: 'TIER_250' },
      { phoneNumberId: 'pn-2', quality: 'green', messagingLimit: undefined },
    ]);
  });

  it('el sobre de Zavu no se lee como webhook de Meta, y no se inventa el evento', () => {
    // Esto es lo que de verdad llega hoy a /webhooks/channels/:accountId: el
    // sobre de Zavu, sin `entry`. El parser de Meta devolvía [] sobre CUALQUIER
    // evento de Zavu y nadie se enteraba. Zavu todavía no publica un evento de
    // calidad de número, así que sigue siendo [] — pero ahora a propósito y por
    // la rama correcta, no por accidente de formato.
    const sobre = {
      id: 'evt_1705312200000_abc123',
      type: 'message.delivered',
      timestamp: 1705312200000,
      senderId: 'snd_calidad_zavu',
      projectId: 'prj_xyz789',
      data: { messageId: 'jd7x2k3m4n5p6q7r8s9t0', status: 'delivered' },
    };
    expect(normalizeQualityUpdates(sobre)).toEqual([]);
    // Y un cuerpo raro no puede tumbar el webhook: antes `null` reventaba con
    // "cannot read properties of null", y eso devolvía 500 al proveedor.
    expect(normalizeQualityUpdates({})).toEqual([]);
    expect(normalizeQualityUpdates(null)).toEqual([]);
    expect(normalizeQualityUpdates(undefined)).toEqual([]);
  });

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

// La identidad del número en Zavu es el senderId (ADR-0014). Con Zavu en medio,
// phone_number_id es NULL y la búsqueda vieja no encontraba fila NUNCA: el freno
// del #45 salía en silencio con changed:false aunque el aviso llegara perfecto.
describe('calidad del número: identidad por senderId (#45, ADR-0014)', () => {
  it('la fila que crea Zavu NO tiene phone_number_id: esa es la premisa', async () => {
    const fila = await admin.query(
      'SELECT sender_id, phone_number_id FROM whatsapp_numbers WHERE tenant_id = $1',
      [tenantZavu],
    );
    expect(fila.rows[0].sender_id).toBe('snd_calidad_zavu');
    expect(fila.rows[0].phone_number_id).toBeNull();
  });

  it('en ROJO por senderId: pausa lo del negocio, degrada el canal y avisa', async () => {
    const res = await withTenant(admin, tenantZavu, (c) =>
      applyQualityUpdate(c, {
        tenantId: tenantZavu,
        update: { senderId: 'snd_calidad_zavu', quality: 'red', messagingLimit: 'TIER_1K' },
      }),
    );
    expect(res).toEqual({ changed: true, pausado: true });
    expect(await eventos('number.quality_changed', tenantZavu)).toBe(1);
    expect(await eventos('channel.degraded', tenantZavu)).toBe(1);

    const pausa = await withTenant(admin, tenantZavu, (c) =>
      isBusinessPaused(c, tenantZavu, cuentaZavu),
    );
    expect(pausa).toMatch(/pausamos los envíos/);
    const canal = await admin.query('SELECT state FROM channel_accounts WHERE id = $1', [
      cuentaZavu,
    ]);
    expect(canal.rows[0].state).toBe('degraded');
    // Y la campaña (#75) ya lo ve: el número quedó en rojo de verdad, en la base.
    expect(await withTenant(admin, tenantZavu, (c) => numeroEnRojo(c, tenantZavu))).toBe(true);
  });

  it('el senderId de otro tenant no toca este número', async () => {
    // El aviso trae un sender que no es de este tenant: no hay nada que aplicar,
    // y sobre todo no se agarra la primera fila que aparezca.
    const res = await withTenant(admin, tenantZavu, (c) =>
      applyQualityUpdate(c, {
        tenantId: tenantZavu,
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
      withTenant(admin, tenantZavu, (c) =>
        applyQualityUpdate(c, { tenantId: tenantZavu, update: { quality: 'red' } }),
      ),
    ).rejects.toThrow(/no dice de qué número habla/);
  });
});
