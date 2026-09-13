import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  advanceOnboarding,
  changePlan,
  changeTenantState,
  createTenant,
  getPlanLimits,
  getTenant,
} from '../application/tenants';
import { getUsage, incrementUsage } from '../application/usage';
import { assertTransition } from '../domain/state';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenantId: string;
const creados: string[] = [];

// Los medidores se leen/escriben como el ROL DE APLICACIÓN: un superusuario
// se salta RLS y el test de aislamiento mentiría (ver packages/db/README.md).
async function conTenant<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return withTenant(app, tenantId, fn);
}

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
  await admin.query('GRANT SELECT, INSERT, UPDATE ON usage_meters TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));
});

afterAll(async () => {
  await app.end();
  for (const id of creados) {
    await admin.query('DELETE FROM usage_meters WHERE tenant_id = $1', [id]);
    await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
  }
  await admin.end();
});

describe('organizations', () => {
  it('el tenant nace en trial con 14 días y el plan de prueba Crece', async () => {
    const client = await admin.connect();
    try {
      const tenant = await createTenant(client, { name: 'Barbería Test', rubro: 'servicios' });
      creados.push(tenant.id);
      tenantId = tenant.id;
      expect(tenant.state).toBe('trial');
      expect(tenant.plan).toBe('crece');
      expect(tenant.onboardingState).toBe('registered');
      const dias = (tenant.trialEndsAt!.getTime() - Date.now()) / 86_400_000;
      expect(dias).toBeGreaterThan(13.9);
      expect(dias).toBeLessThan(14.1);
    } finally {
      client.release();
    }
  });

  it('las transiciones siguen la máquina de estados y las inválidas se rechazan', async () => {
    const client = await admin.connect();
    try {
      await changeTenantState(client, tenantId, 'active');
      await changeTenantState(client, tenantId, 'past_due');
      await changeTenantState(client, tenantId, 'read_only');
      const tenant = await getTenant(client, tenantId);
      expect(tenant.state).toBe('read_only');

      await expect(changeTenantState(client, tenantId, 'trial')).rejects.toThrow(/inválida/);
      expect(() => assertTransition('deleted', 'active')).toThrow(/inválida/);
      await changeTenantState(client, tenantId, 'active');
    } finally {
      client.release();
    }
  });

  it('cambiar de plan recalcula los límites desde plan_limits', async () => {
    const client = await admin.connect();
    try {
      const limites = await changePlan(client, tenantId, 'base');
      expect(limites.whatsappNumbers).toBe(1);
      expect(limites.retentionMonths).toBe(12);
      expect(limites.modules).toContain('crm');
      expect(limites.modules).not.toContain('automations');

      const equipo = await getPlanLimits(client, 'equipo');
      expect(equipo.retentionMonths).toBeNull();
      await expect(getPlanLimits(client, 'fantasma')).rejects.toThrow(/Plan desconocido/);
    } finally {
      client.release();
    }
  });

  it('el onboarding avanza y no retrocede', async () => {
    const client = await admin.connect();
    try {
      await advanceOnboarding(client, tenantId, 'configured');
      await advanceOnboarding(client, tenantId, 'whatsapp_connected');
      await expect(advanceOnboarding(client, tenantId, 'configured')).rejects.toThrow(/no retrocede/);
    } finally {
      client.release();
    }
  });

  it('los medidores acumulan por evento dentro del ciclo, bajo RLS', async () => {
    expect(await conTenant((c) => incrementUsage(c, tenantId, 'conversations'))).toBe(1);
    expect(await conTenant((c) => incrementUsage(c, tenantId, 'conversations', 4))).toBe(5);
    expect(await conTenant((c) => getUsage(c, tenantId, 'conversations'))).toBe(5);
    expect(await conTenant((c) => getUsage(c, tenantId, 'ia_executions'))).toBe(0);
  });

  it('un tenant no ve los medidores de otro (RLS)', async () => {
    const client = await admin.connect();
    let otro: string;
    try {
      const t = await createTenant(client, { name: 'Otro Negocio' });
      otro = t.id;
      creados.push(otro);
    } finally {
      client.release();
    }
    const ajeno = await withTenant(app, otro, (c) =>
      c.query('SELECT * FROM usage_meters'),
    );
    expect(ajeno.rowCount).toBe(0);
  });
});
