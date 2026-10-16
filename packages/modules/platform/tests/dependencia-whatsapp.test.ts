import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ModuleRegistry, CORE_MODULES } from '@iaxti/core';
import { createPool, runMigrations, topologicalOrder, findModulesDir } from '@iaxti/db';
import { securitySnapshot } from '../application/salud';

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
  tenant = (await pool.query("INSERT INTO tenants (name,plan,state) VALUES ($1,'crece','active') RETURNING id", ['dependencia-platform-whatsapp'])).rows[0].id;
});
afterAll(async () => {
  for (const tabla of ["whatsapp_numbers", "channel_accounts"]) {
    await pool.query(`DELETE FROM ${tabla} WHERE tenant_id=$1`, [tenant]);
  }
  await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]);
  await pool.end();
});

it('declara el cruce y registry/migraciones aceptan la misma composición', async () => {
  const registry = new ModuleRegistry().load();
  expect(registry.manifest('platform').depends_on?.optional).toContain('whatsapp');
  expect(topologicalOrder(findModulesDir())).toEqual(registry.initOrder());
  expect(await runMigrations(pool)).toEqual([]); // repetición idempotente real
});

it('con whatsapp apagado sigue denunciando un número en rojo', async () => {
  const registry = soloRequeridos();
  expect(registry.isActive('whatsapp')).toBe(false);
  const cuenta = (await pool.query(`INSERT INTO channel_accounts (tenant_id,kind,name,state)
    VALUES ($1,'whatsapp','Demo','active') RETURNING id`, [tenant])).rows[0].id;
  await pool.query(`INSERT INTO whatsapp_numbers (tenant_id, channel_account_id, sender_id, quality)
    VALUES ($1,$2,$3,'red')`, [tenant, cuenta, tenant]);
  const snap = await securitySnapshot(pool, { redis: null });
  expect(snap.numerosEnRiesgo.filas.some((fila) => fila.tenant_id === tenant && fila.quality === 'red')).toBe(true);
  expect(snap.chequeos.find((c) => c.id === 'numeros')!.estado).toBe('mal');
});
