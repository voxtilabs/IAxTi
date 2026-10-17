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
  tenant = (await pool.query("INSERT INTO tenants (name,plan,state) VALUES ($1,'crece','active') RETURNING id", ['dependencia-platform-integrations'])).rows[0].id;
});
afterAll(async () => {
  for (const tabla of ["webhook_deliveries", "webhook_endpoints"]) {
    await pool.query(`DELETE FROM ${tabla} WHERE tenant_id=$1`, [tenant]);
  }
  await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]);
  await pool.end();
});

it('declara el cruce y registry/migraciones aceptan la misma composición', async () => {
  const registry = new ModuleRegistry().load();
  expect(registry.manifest('platform').depends_on?.optional).toContain('integrations');
  expect(topologicalOrder(findModulesDir())).toEqual(registry.initOrder());
  expect(await runMigrations(pool)).toEqual([]); // repetición idempotente real
});

it('con integrations apagado conserva la alerta de entregas fallidas existentes', async () => {
  const registry = soloRequeridos();
  expect(registry.isActive('integrations')).toBe(false);
  const endpoint = (await pool.query(`INSERT INTO webhook_endpoints (tenant_id,url,secret)
    VALUES ($1,'https://example.invalid/hook','fixture-local') RETURNING id`, [tenant])).rows[0].id;
  await pool.query(`INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_name, payload, status)
    VALUES ($1,$2,901,'demo.event','{}','failed')`, [tenant, endpoint]);
  const snap = await securitySnapshot(pool, { redis: null });
  expect(snap.webhooksFallidos.filas.some((fila) => fila.tenant_id === tenant && fila.endpoint_id === endpoint && fila.n === 1)).toBe(true);
  expect(snap.chequeos.find((c) => c.id === 'webhooks')!.estado).toBe('atencion');
});
