import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ModuleRegistry, CORE_MODULES } from '@iaxti/core';
import { createPool, runMigrations, topologicalOrder, findModulesDir, withTenant } from '@iaxti/db';
import { tenantRetentionPreview } from '../application/planes';

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
  tenant = (await pool.query("INSERT INTO tenants (name,plan,state) VALUES ($1,'crece','active') RETURNING id", ['dependencia-platform-conversations'])).rows[0].id;
});
afterAll(async () => {
  for (const tabla of ["messages", "conversations", "contacts"]) {
    await pool.query(`DELETE FROM ${tabla} WHERE tenant_id=$1`, [tenant]);
  }
  await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]);
  await pool.end();
});

it('declara el cruce y registry/migraciones aceptan la misma composición', async () => {
  const registry = new ModuleRegistry().load();
  expect(registry.manifest('platform').depends_on?.optional).toContain('conversations');
  expect(topologicalOrder(findModulesDir())).toEqual(registry.initOrder());
  expect(await runMigrations(pool)).toEqual([]); // repetición idempotente real
});

it('con conversations apagado sigue contando el histórico realmente sujeto a retención', async () => {
  const registry = soloRequeridos();
  expect(registry.isActive('conversations')).toBe(false);
  const contacto = (await pool.query("INSERT INTO contacts (tenant_id, name, origin) VALUES ($1,'Demo','manual') RETURNING id", [tenant])).rows[0].id;
  await pool.query(`INSERT INTO conversations (tenant_id, contact_id, channel, state, last_message_at)
    VALUES ($1,$2,'webchat','resolved','2000-01-01T12:00:00Z'), ($1,$2,'webchat','open','2000-01-01T12:00:00Z')`, [tenant, contacto]);
  const vista = await withTenant(pool, tenant, (c) => tenantRetentionPreview(c, tenant));
  expect(vista.months).not.toBeNull();
  expect(vista.wouldPurge).toBe(1);
});
