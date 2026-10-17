import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ModuleRegistry, CORE_MODULES } from '@iaxti/core';
import { createPool, runMigrations, topologicalOrder, findModulesDir, withTenant, sinTriggers } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';
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
  tenant = (await pool.query("INSERT INTO tenants (name,plan,state) VALUES ($1,'crece','active') RETURNING id", ['dependencia-platform-audit'])).rows[0].id;
});
afterAll(async () => {
  await sinTriggers(pool, (c) => c.query('DELETE FROM audit_log WHERE tenant_id=$1', [tenant]));
  await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]);
  await pool.end();
});

it('declara el cruce y registry/migraciones aceptan la misma composición', async () => {
  const registry = new ModuleRegistry().load();
  expect(registry.manifest('platform').depends_on?.required).toContain('audit');
  expect(topologicalOrder(findModulesDir())).toEqual(registry.initOrder());
  expect(await runMigrations(pool)).toEqual([]); // repetición idempotente real
});

it('requiere el libro del núcleo y muestra sus denegaciones sin sustituirlo por cero', async () => {
  const registry = soloRequeridos();
  expect(registry.isActive('audit')).toBe(true);
  expect(() => registry.disable('audit')).toThrow(/núcleo/);
  expect(registry.initOrder().indexOf('audit')).toBeLessThan(registry.initOrder().indexOf('platform'));
  await withTenant(pool, tenant, (c) => writeAudit(c, { tenantId: tenant, actor: 'revision901', actorKind: 'user',
    action: 'permission.denied', resource: 'payments.refund', result: 'denied' }));
  const snap = await securitySnapshot(pool, { redis: null });
  expect(snap.permisosDenegados.filas.some((fila) => fila.tenant_id === tenant && fila.n === 1)).toBe(true);
  const sinLibro = new Proxy(pool, { get(target, prop) {
    if (prop === 'query') return (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM audit_log')) return Promise.reject(new Error('libro no disponible'));
      return target.query(sql, values);
    };
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await expect(securitySnapshot(sinLibro, { redis: null })).rejects.toThrow('libro no disponible');
});
