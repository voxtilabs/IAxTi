import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ModuleRegistry, CORE_MODULES } from '@iaxti/core';
import { createPool, runMigrations, topologicalOrder, findModulesDir } from '@iaxti/db';
import { randomUUID } from 'node:crypto';
import { tenantsOf } from '../application/invitations';

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
  requerir('identity');
  for (const id of registry.initOrder().reverse()) {
    if (!mantener.has(id)) registry.disable(id);
  }
  expect(registry.isActive('identity')).toBe(true);
  return registry;
}

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants (name,plan,state) VALUES ($1,'crece','active') RETURNING id", ['dependencia-identity-organizations'])).rows[0].id;
});
afterAll(async () => {
  for (const tabla of ["user_roles"]) {
    await pool.query(`DELETE FROM ${tabla} WHERE tenant_id=$1`, [tenant]);
  }
  await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]);
  await pool.end();
});

it('declara el cruce y registry/migraciones aceptan la misma composición', async () => {
  const registry = new ModuleRegistry().load();
  expect(registry.manifest('identity').depends_on?.optional).toContain('organizations');
  expect(topologicalOrder(findModulesDir())).toEqual(registry.initOrder());
  expect(await runMigrations(pool)).toEqual([]); // repetición idempotente real
});

it('el núcleo conserva organizations sin crear el ciclo de inicialización inverso', async () => {
  const registry = soloRequeridos();
  expect(() => registry.disable('organizations')).toThrow(/núcleo/);
  expect(() => registry.killSwitch('organizations', true)).toThrow(/núcleo/);
  expect(registry.initOrder().indexOf('identity')).toBeLessThan(registry.initOrder().indexOf('organizations'));
  const usuario = randomUUID();
  await pool.query(`INSERT INTO user_roles (tenant_id, user_id, role_id)
    SELECT $1,$2,id FROM roles WHERE name='ADMIN' AND tenant_id IS NULL`, [tenant, usuario]);
  const c = await pool.connect();
  try {
    expect(await tenantsOf(c, usuario)).toEqual([{ tenantId: tenant, tenantName: 'dependencia-identity-organizations', roleName: 'ADMIN' }]);
  } finally { c.release(); }
});
