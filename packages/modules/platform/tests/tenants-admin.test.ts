import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import {
  adminChangePlan,
  adminCreateTenant,
  adminExtendTrial,
  adminSetTenantState,
  endSupportSession,
  startSupportSession,
  supportStatus,
  tenantDetail,
} from '../application/tenants-admin';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const superadmin = randomUUID();

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const creado = await adminCreateTenant(admin, {
    name: 'Peluquería Admin Test',
    plan: 'base',
    rubro: 'belleza',
    adminUser: superadmin,
  });
  tenant = creado.id;
});

afterAll(async () => {
  await admin.query('DELETE FROM platform_support_sessions WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM usage_meters WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

describe('gestión de tenants (#68)', () => {
  it('crear deja el tenant en trial con el plan pedido, auditado como superadmin', async () => {
    const client = await admin.connect();
    let detalle;
    try {
      detalle = await tenantDetail(client, tenant);
    } finally {
      client.release();
    }
    expect(detalle.state).toBe('trial');
    expect(detalle.plan).toBe('base');
    expect(detalle.trialEndsAt).not.toBeNull();

    const audit = await admin.query(
      `SELECT actor_kind FROM audit_log WHERE tenant_id = $1 AND action = 'platform.tenant.create'`,
      [tenant],
    );
    expect(audit.rows[0].actor_kind).toBe('superadmin');
  });

  it('extender la prueba suma días; reactivar desde trial activa', async () => {
    const antes = new Date();
    const ext = await adminExtendTrial(admin, { tenantId: tenant, days: 14, adminUser: superadmin });
    expect(new Date(ext.trialEndsAt).getTime()).toBeGreaterThan(antes.getTime() + 13 * 86_400_000);
    await expect(
      adminExtendTrial(admin, { tenantId: tenant, days: 200, adminUser: superadmin }),
    ).rejects.toThrow(/90/);

    const activo = await adminSetTenantState(admin, { tenantId: tenant, action: 'reactivate', adminUser: superadmin });
    expect(activo.state).toBe('active');
  });

  it('suspender desde active recorre la máquina §6; reactivar vuelve', async () => {
    const sus = await adminSetTenantState(admin, { tenantId: tenant, action: 'suspend', adminUser: superadmin });
    expect(sus.state).toBe('suspended');
    const estado = await admin.query('SELECT state FROM tenants WHERE id = $1', [tenant]);
    expect(estado.rows[0].state).toBe('suspended');

    const act = await adminSetTenantState(admin, { tenantId: tenant, action: 'reactivate', adminUser: superadmin });
    expect(act.state).toBe('active');

    const audit = await admin.query(
      `SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'platform.tenant.%' ORDER BY id`,
      [tenant],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['platform.tenant.suspend', 'platform.tenant.reactivate']),
    );
  });

  it('cambiar plan recalcula límites (§6) y queda en el libro', async () => {
    await adminChangePlan(admin, { tenantId: tenant, plan: 'equipo', adminUser: superadmin });
    const t = await admin.query('SELECT plan FROM tenants WHERE id = $1', [tenant]);
    expect(t.rows[0].plan).toBe('equipo');
    await expect(
      adminChangePlan(admin, { tenantId: tenant, plan: 'pirata', adminUser: superadmin }),
    ).rejects.toThrow();
  });

  it('el modo soporte se ve desde el tenant, expira acotado y se cierra', async () => {
    const client = await admin.connect();
    try {
      expect((await supportStatus(client, tenant)).active).toBe(false);

      const s = await startSupportSession(admin, {
        tenantId: tenant,
        adminUser: superadmin,
        hours: 2,
        reason: 'revisión de bandeja',
      });
      expect(new Date(s.until).getTime()).toBeGreaterThan(Date.now());

      const activo = await supportStatus(client, tenant);
      expect(activo.active).toBe(true); // el AVISO que ve el tenant

      await endSupportSession(admin, { tenantId: tenant, adminUser: superadmin });
      expect((await supportStatus(client, tenant)).active).toBe(false);
    } finally {
      client.release();
    }
    const audit = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action LIKE 'platform.support.%'`,
      [tenant],
    );
    expect(audit.rows[0].n).toBe(2); // start + end, con actor_kind superadmin
  });
});
