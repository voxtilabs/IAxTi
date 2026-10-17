import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';
import {
  guardarRetencionTenant, leerRetencionTenant, marcarAvisoDeBorrado,
  editarLimitesDelPlan, extenderPrueba, updateTenantSettings,
} from '@iaxti/module-organizations';
import { setRetentionOverridePlatform, adminExtendTrial, updatePlan } from '@iaxti/module-platform';
import { setRetentionOverride } from '@iaxti/module-conversations';

let admin: Pool;
let app: Pool;
const rol = `org_${randomUUID().replaceAll('-', '')}`;
const actor = randomUUID();
const plan = `plan_${randomUUID()}`;
const ahora = new Date('2026-10-15T12:00:00Z');
const auditoria = { actor, actorKind: 'user' as const, registrar: writeAudit };

beforeAll(async () => {
  admin = createPool(process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti');
  await runMigrations(admin);
  await admin.query(`CREATE ROLE ${rol} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${rol}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${rol}`);
  await admin.query(`REVOKE UPDATE, DELETE ON audit_log FROM ${rol}`);
  await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${rol}`);
  app = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c role=${rol}` });
  expect((await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0])
    .toEqual({ rolsuper: false, rolbypassrls: false });
  await admin.query(
    `INSERT INTO plan_limits (plan, whatsapp_numbers, conversations_month, ia_executions_month, retention_months, modules, price_clp)
     VALUES ($1, 1, 500, 1000, 12, '[]', 20000)`, [plan],
  );
});

afterAll(async () => {
  await app.end();
  await admin.query(`DROP OWNED BY ${rol}`);
  await admin.query(`DROP ROLE ${rol}`);
  await admin.query('DELETE FROM plan_limits WHERE plan = $1', [plan]);
  await admin.end();
});

async function tenant(state = 'active') {
  const r = await admin.query(
    `INSERT INTO tenants (name, plan, state, state_since, settings)
     VALUES ('org-907', $1, $2, now() - interval '80 days', '{"bandeja":{"saludo":"hola"}}') RETURNING id`,
    [plan, state],
  );
  return r.rows[0].id as string;
}

async function fila(id: string) {
  return (await admin.query('SELECT settings, trial_ends_at, deletion_warned_at FROM tenants WHERE id = $1', [id])).rows[0];
}

async function rastros(id: string) {
  return (await admin.query('SELECT action, actor, actor_kind, metadata FROM audit_log WHERE tenant_id = $1 ORDER BY id', [id])).rows;
}

function fallaAuditoria(c: PoolClient): Promise<void> {
  return c.query('SELECT 1 / 0').then(() => undefined);
}

describe('organizations es dueño de sus escrituras (#907)', () => {
  it('los dos consumidores guardan la misma forma sin pisar ajustes ni la marca de aviso', async () => {
    const id = await tenant();
    const aviso = new Date('2026-11-14T12:00:00Z');
    await withTenant(app, id, (c) => guardarRetencionTenant(c, { tenantId: id, firstPurgeAfter: aviso, auditoria }));
    await withTenant(app, id, (c) => setRetentionOverride(c, { tenantId: id, months: 6, actor }));
    await setRetentionOverridePlatform(app, { tenantId: id, months: 3, adminUser: actor });
    expect((await fila(id)).settings).toEqual({ bandeja: { saludo: 'hola' }, retencion: { monthsOverride: 3, firstPurgeAfter: aviso.toISOString() } });
    expect((await rastros(id)).map((r) => [r.actor, r.actor_kind])).toEqual([[actor, 'user'], [actor, 'user'], [actor, 'superadmin']]);
    const global = await admin.query("SELECT metadata FROM platform_audit WHERE admin_user = $1 AND action = 'platform.tenant.retention_override'", [actor]);
    expect(global.rows.some((r) => r.metadata.tenantId === id)).toBe(true);
    // Una purga vieja no puede quitar la protección de un aviso recién emitido.
    await withTenant(app, id, (c) => guardarRetencionTenant(c, { tenantId: id, firstPurgeAfter: null, now: ahora, auditoria }));
    expect((await fila(id)).settings.retencion.firstPurgeAfter).toBe(aviso.toISOString());
    await withTenant(app, id, (c) => guardarRetencionTenant(c, { tenantId: id, firstPurgeAfter: null, now: new Date('2026-11-15T12:00:00Z'), auditoria }));
    expect((await fila(id)).settings.retencion).toEqual({ monthsOverride: 3 });
    expect((await rastros(id)).at(-1)?.metadata).toEqual({ firstPurgeAfter: null });
  });

  it('rechaza meses inválidos, mayor que el plan y atajo por settings genérico', async () => {
    const id = await tenant();
    for (const months of [0, -1, 1.5, Infinity, 13]) {
      await expect(withTenant(app, id, (c) => guardarRetencionTenant(c, { tenantId: id, monthsOverride: months, auditoria }))).rejects.toThrow(/retención|plan/);
    }
    await expect(withTenant(app, id, (c) => updateTenantSettings(c, id, { retencion: { monthsOverride: 999 } }))).rejects.toThrow(/contrato/);
    expect((await fila(id)).settings.retencion).toBeUndefined();
    expect(await rastros(id)).toHaveLength(0);
    await withTenant(app, id, (c) => guardarRetencionTenant(c, { tenantId: id, monthsOverride: null, auditoria }));
    expect(await withTenant(app, id, (c) => leerRetencionTenant(c, id))).toEqual({ months: 12, firstPurgeAfter: null });
  });

  it('sin contexto o con otro tenant no puede escribir, aunque tenants no tenga RLS', async () => {
    const a = await tenant();
    const b = await tenant();
    const antes = await fila(b);
    await expect(withTenant(app, a, (c) => guardarRetencionTenant(c, { tenantId: b, monthsOverride: 3, auditoria }))).rejects.toThrow(/contexto/);
    await expect(withTenant(app, a, (c) => marcarAvisoDeBorrado(c, { tenantId: b, diasMinimos: 75, auditoria }))).rejects.toThrow(/contexto/);
    await expect(withTenant(app, a, (c) => extenderPrueba(c, { tenantId: b, days: 7, auditoria: { ...auditoria, actorKind: 'superadmin' } }))).rejects.toThrow(/contexto/);
    const c = await app.connect();
    try {
      await expect(guardarRetencionTenant(c, { tenantId: b, monthsOverride: 3, auditoria })).rejects.toThrow(/contexto/);
    } finally { c.release(); }
    expect(await fila(b)).toEqual(antes);
  });

  it('revierte retención y operaciones anteriores cuando falla auditoría del dueño', async () => {
    const id = await tenant();
    const antes = await fila(id);
    await expect(withTenant(app, id, async (c) => {
      await guardarRetencionTenant(c, { tenantId: id, monthsOverride: 6, auditoria });
      await guardarRetencionTenant(c, { tenantId: id, firstPurgeAfter: new Date('2026-11-14T12:00:00Z'), auditoria: { ...auditoria, registrar: fallaAuditoria } });
    })).rejects.toThrow(/division by zero/);
    expect(await fila(id)).toEqual(antes);
    expect(await rastros(id)).toHaveLength(0);
  });

  it('el aviso revalida estado, no se duplica y revierte si falla el evento del llamador', async () => {
    const id = await tenant('suspended');
    await expect(withTenant(app, id, async (c) => {
      await marcarAvisoDeBorrado(c, { tenantId: id, diasMinimos: 75, auditoria });
      await c.query('SELECT 1 / 0');
    })).rejects.toThrow(/division by zero/);
    expect((await fila(id)).deletion_warned_at).toBeNull();
    expect(await rastros(id)).toHaveLength(0);
    expect(await withTenant(app, id, (c) => marcarAvisoDeBorrado(c, { tenantId: id, diasMinimos: 75, auditoria }))).not.toBeNull();
    expect(await withTenant(app, id, (c) => marcarAvisoDeBorrado(c, { tenantId: id, diasMinimos: 75, auditoria }))).toBeNull();
    const activo = await tenant();
    expect(await withTenant(app, activo, (c) => marcarAvisoDeBorrado(c, { tenantId: activo, diasMinimos: 75, auditoria }))).toBeNull();
  });

  it('extender prueba preserva actor de plataforma y revierte si falla su auditoría', async () => {
    const id = await tenant('trial');
    await adminExtendTrial(app, { tenantId: id, days: 7, adminUser: actor });
    expect((await rastros(id))[0]).toMatchObject({ actor, actor_kind: 'superadmin', action: 'platform.tenant.extend_trial' });
    const antes = await fila(id);
    await expect(withTenant(app, id, (c) => extenderPrueba(c, { tenantId: id, days: 1, auditoria }))).rejects.toThrow(/plataforma/);
    await expect(withTenant(app, id, (c) => extenderPrueba(c, { tenantId: id, days: 1, auditoria: { ...auditoria, actorKind: 'superadmin', registrar: fallaAuditoria } }))).rejects.toThrow(/division by zero/);
    expect(await fila(id)).toEqual(antes);
  });

  it('límites y auditoría global van juntos; el callback recibe el cliente exacto', async () => {
    const antes = (await admin.query('SELECT * FROM plan_limits WHERE plan = $1', [plan])).rows[0];
    await expect(withTenant(app, await tenant(), async (c) => {
      await editarLimitesDelPlan(c, {
        plan, changes: { priceClp: 12345 }, knownModules: [], actor,
        auditar: async (recibido) => { expect(recibido).toBe(c); await fallaAuditoria(recibido); },
      });
    })).rejects.toThrow(/division by zero/);
    expect((await admin.query('SELECT * FROM plan_limits WHERE plan = $1', [plan])).rows[0]).toEqual(antes);
    await updatePlan(app, { plan, changes: { priceClp: 25000 }, knownModules: [], adminUser: actor });
    expect((await admin.query('SELECT price_clp FROM plan_limits WHERE plan = $1', [plan])).rows[0].price_clp).toBe('25000');
    expect((await admin.query("SELECT metadata FROM platform_audit WHERE admin_user = $1 AND action = 'platform.plan.update'", [actor])).rows.some((r) => r.metadata.plan === plan)).toBe(true);
  });
});
