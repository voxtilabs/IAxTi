import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  applyQualityUpdate,
  isBusinessPaused,
  normalizeQualityUpdates,
  resumeBusinessSends,
} from '../application/quality';
import { connectWhatsAppNumber } from '../application/numbers';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let numero: string;
let cuenta: string;

async function eventos(nombre: string): Promise<number> {
  const r = await admin.query(
    'SELECT count(*)::int AS n FROM outbox WHERE name = $1 AND tenant_id = $2',
    [nombre, tenant],
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
});

afterAll(async () => {
  await admin.query('DELETE FROM whatsapp_numbers WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
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
