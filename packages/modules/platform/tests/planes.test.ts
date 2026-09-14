import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { ModuleRegistry } from '@iaxti/core';
import { receiveInbound } from '@iaxti/module-conversations';
import {
  applyModuleFlags,
  listPlans,
  setModuleFlag,
  setRetentionOverridePlatform,
  tenantRetentionPreview,
  updatePlan,
} from '../application/planes';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const superadmin = randomUUID();

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan, state) VALUES ('planes-test', 'base', 'active') RETURNING id",
  );
  tenant = t.rows[0].id;
});

afterAll(async () => {
  // Los flags de módulos son GLOBALES: se limpian para no romper otros tests.
  await admin.query(`DELETE FROM platform_module_flags`);
  await admin.query(`DELETE FROM platform_audit WHERE admin_user = $1`, [superadmin]);
  await admin.query(
    `UPDATE plan_limits SET price_clp = 29990, api_requests_month = 10000 WHERE plan = 'base'`,
  );
  for (const tabla of ['messages', 'conversations', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('planes como configuración (#69)', () => {
  it('editar límites y precio SIN deploy, validado y en platform_audit', async () => {
    const antes = await listPlans(admin);
    expect(antes.find((p) => p.plan === 'base')?.priceClp).toBe(29990);

    const editado = await updatePlan(admin, {
      plan: 'base',
      changes: { priceClp: 34990, apiRequestsMonth: 15000 },
      knownModules: [],
      adminUser: superadmin,
    });
    expect(editado.priceClp).toBe(34990);
    expect(editado.apiRequestsMonth).toBe(15000);

    await expect(
      updatePlan(admin, { plan: 'base', changes: { priceClp: -5 }, knownModules: [], adminUser: superadmin }),
    ).rejects.toThrow(/entiende/);
    await expect(
      updatePlan(admin, { plan: 'base', changes: { modules: ['modulo-pirata'] }, knownModules: ['crm'], adminUser: superadmin }),
    ).rejects.toThrow(/no existen/);

    const audit = await admin.query(
      `SELECT count(*)::int AS n FROM platform_audit WHERE admin_user = $1 AND action = 'platform.plan.update'`,
      [superadmin],
    );
    expect(audit.rows[0].n).toBe(1);
  });
});

describe('módulos con kill-switch (#69)', () => {
  it('apagar respeta dependencias, persiste y otro proceso lo aplica en su refresh', async () => {
    const registry = new ModuleRegistry().load();
    // crm lo requieren módulos activos: el registry se niega con voz clara.
    await expect(
      setModuleFlag(admin, registry, { moduleId: 'crm', action: 'disable', adminUser: superadmin }),
    ).rejects.toThrow(/requieren|núcleo/);

    // knowledge no es requerido por nadie: se apaga y PERSISTE.
    const filas = await setModuleFlag(admin, registry, {
      moduleId: 'knowledge',
      action: 'disable',
      adminUser: superadmin,
    });
    expect(filas.find((m) => m.id === 'knowledge')?.active).toBe(false);
    expect(filas.find((m) => m.id === 'knowledge')?.tenantsUsing).toBeGreaterThanOrEqual(0);

    // "Otro proceso": un registry nuevo toma el flag de la DB en su refresh.
    const otroProceso = new ModuleRegistry().load();
    expect(otroProceso.isActive('knowledge')).toBe(true); // recién cargado
    const aplicados = await applyModuleFlags(admin, otroProceso);
    expect(aplicados).toBeGreaterThanOrEqual(1);
    expect(otroProceso.isActive('knowledge')).toBe(false); // sin desplegar

    // Kill-switch y vuelta.
    await setModuleFlag(admin, registry, { moduleId: 'knowledge', action: 'enable', adminUser: superadmin });
    await setModuleFlag(admin, registry, { moduleId: 'knowledge', action: 'kill_on', adminUser: superadmin });
    expect(registry.isActive('knowledge')).toBe(false);
    await setModuleFlag(admin, registry, { moduleId: 'knowledge', action: 'kill_off', adminUser: superadmin });
    expect(registry.isActive('knowledge')).toBe(true);
  });
});

describe('override por tenant (#69)', () => {
  it('la retención muestra el CONTEO de la próxima purga y valida ≤ plan', async () => {
    // Una conversación vieja purgable.
    const res = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, { tenantId: tenant, phone: '+56902020001', channel: 'simulador', body: 'antigua' }),
    );
    await admin.query(
      `UPDATE conversations SET state = 'resolved', last_message_at = now() - interval '14 months' WHERE id = $1`,
      [res.conversation.id],
    );

    const client = await admin.connect();
    try {
      const preview = await tenantRetentionPreview(client, tenant);
      expect(preview.months).toBe(12); // plan base
      expect(preview.wouldPurge).toBe(1); // el conteo exacto
    } finally {
      client.release();
    }

    await expect(
      setRetentionOverridePlatform(admin, { tenantId: tenant, months: 24, adminUser: superadmin }),
    ).rejects.toThrow(/plan/);

    const corto = await setRetentionOverridePlatform(admin, { tenantId: tenant, months: 6, adminUser: superadmin });
    expect(corto.months).toBe(6);
    expect(corto.wouldPurge).toBe(1);
  });
});
