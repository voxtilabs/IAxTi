import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ModuleRegistry, CORE_MODULES } from '@iaxti/core';
import { createPool, runMigrations, topologicalOrder, findModulesDir, withTenant } from '@iaxti/db';
import { costosDelCicloEnCurso, ensureSubscription } from '../application/billing';

let pool: Pool;
let tenant: string;

// Solo el consumidor, sus required transitivos y el núcleo. Apagar conserva
// el esquema: no simula desinstalar tablas (SPEC §26.5 y §26.9).
function soloRequeridos(): ModuleRegistry {
  const registry = new ModuleRegistry().load();
  const mantener = new Set<string>(CORE_MODULES);
  function requerir(id: string): void {
    mantener.add(id);
    for (const dep of registry.manifest(id).depends_on?.required ?? []) {
      if (!mantener.has(dep)) requerir(dep);
    }
  }
  requerir('billing');
  for (const id of registry.initOrder().reverse()) {
    if (!mantener.has(id)) registry.disable(id);
  }
  expect(registry.isActive('billing')).toBe(true);
  return registry;
}

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants (name,plan,state) VALUES ($1,'crece','active') RETURNING id", ['dependencia-billing-analytics'])).rows[0].id;
});
afterAll(async () => {
  for (const tabla of ["invoices", "subscriptions", "daily_metrics", "outbox"]) {
    await pool.query(`DELETE FROM ${tabla} WHERE tenant_id=$1`, [tenant]);
  }
  await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]);
  await pool.end();
});

it('declara el cruce y registry/migraciones aceptan la misma composición', async () => {
  const registry = new ModuleRegistry().load();
  expect(registry.manifest('billing').depends_on?.required).toContain('analytics');
  expect(topologicalOrder(findModulesDir())).toEqual(registry.initOrder());
  expect(await runMigrations(pool)).toEqual([]); // repetición idempotente real
});

it('no permite detener el agregador mientras billing sigue activo y calcula con su dato real', async () => {
  const registry = soloRequeridos();
  expect(registry.isActive('analytics')).toBe(true);
  expect(() => registry.disable('analytics')).toThrow(/billing/);
  await withTenant(pool, tenant, async (c) => {
    await ensureSubscription(c, tenant);
    await c.query("UPDATE subscriptions SET cycle_start='2026-10-01', next_charge_at='2026-11-01' WHERE tenant_id=$1", [tenant]);
    await c.query("INSERT INTO daily_metrics (tenant_id, day, metric, value) VALUES ($1,'2026-10-10','costo_meta_usd',40)", [tenant]);
    const costos = await costosDelCicloEnCurso(c, tenant);
    expect(costos!.metaUsd).toBe(40);
    expect(costos!.lines.some((linea) => linea.concepto === 'exceso_meta' && linea.amountClp > 0)).toBe(true);
  });
  registry.disable('billing');
  registry.disable('analytics');
  expect(registry.isActive('analytics')).toBe(false);
  expect(() => registry.enable('billing')).toThrow(/analytics/);
});
