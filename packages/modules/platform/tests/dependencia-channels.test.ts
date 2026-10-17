import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ModuleRegistry, CORE_MODULES } from '@iaxti/core';
import { createPool, runMigrations, topologicalOrder, findModulesDir, withTenant } from '@iaxti/db';
import { healthSnapshot } from '../application/salud';
import { tenantDetail } from '../application/tenants-admin';

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
  requerir('platform');
  for (const id of registry.initOrder().reverse()) {
    if (!mantener.has(id)) registry.disable(id);
  }
  expect(registry.isActive('platform')).toBe(true);
  return registry;
}

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants (name,plan,state) VALUES ($1,'crece','active') RETURNING id", ['dependencia-platform-channels'])).rows[0].id;
});
afterAll(async () => {
  for (const tabla of ["channel_accounts"]) {
    await pool.query(`DELETE FROM ${tabla} WHERE tenant_id=$1`, [tenant]);
  }
  await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]);
  await pool.end();
});

it('declara el cruce y registry/migraciones aceptan la misma composición', async () => {
  const registry = new ModuleRegistry().load();
  expect(registry.manifest('platform').depends_on?.optional).toContain('channels');
  expect(topologicalOrder(findModulesDir())).toEqual(registry.initOrder());
  expect(await runMigrations(pool)).toEqual([]); // repetición idempotente real
});

it('con channels apagado sigue mostrando una cuenta degradada del negocio', async () => {
  const registry = soloRequeridos();
  expect(registry.isActive('channels')).toBe(false);
  await pool.query("INSERT INTO channel_accounts (tenant_id, kind, name, state) VALUES ($1,'whatsapp','Demo','degraded')", [tenant]);
  const detalle = await withTenant(pool, tenant, (c) => tenantDetail(c, tenant));
  expect(detalle.channels).toContainEqual({ kind: 'whatsapp', state: 'degraded' });
  const snap = await healthSnapshot(pool, { modules: registry.health(), redis: null, env: {} });
  expect(snap.chequeos.find((c) => c.id === 'canales')!.estado).toBe('atencion');
});
