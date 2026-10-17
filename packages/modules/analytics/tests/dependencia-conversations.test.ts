import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ModuleRegistry, CORE_MODULES } from '@iaxti/core';
import { createPool, runMigrations, topologicalOrder, findModulesDir, withTenant } from '@iaxti/db';
import { analyticsConsumers } from '../application/aggregate';
import { getDashboard } from '../application/dashboard';

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
  requerir('analytics');
  for (const id of registry.initOrder().reverse()) {
    if (!mantener.has(id)) registry.disable(id);
  }
  expect(registry.isActive('analytics')).toBe(true);
  return registry;
}

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants (name,plan,state) VALUES ($1,'crece','active') RETURNING id", ['dependencia-analytics-conversations'])).rows[0].id;
});
afterAll(async () => {
  for (const tabla of ["daily_metrics", "response_samples", "messages", "conversations", "contacts", "outbox"]) {
    await pool.query(`DELETE FROM ${tabla} WHERE tenant_id=$1`, [tenant]);
  }
  await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]);
  await pool.end();
});

it('declara el cruce y registry/migraciones aceptan la misma composición', async () => {
  const registry = new ModuleRegistry().load();
  expect(registry.manifest('analytics').depends_on?.optional).toContain('conversations');
  expect(topologicalOrder(findModulesDir())).toEqual(registry.initOrder());
  expect(await runMigrations(pool)).toEqual([]); // repetición idempotente real
});

it('con conversations apagado conserva la lectura y sigue agregando eventos de otros módulos', async () => {
  const registry = soloRequeridos();
  expect(registry.isActive('conversations')).toBe(false);
  expect(registry.isActive('analytics')).toBe(true);
  const contacto = (await pool.query("INSERT INTO contacts (tenant_id, name, origin) VALUES ($1,'Demo','manual') RETURNING id", [tenant])).rows[0].id;
  await pool.query(`INSERT INTO conversations (tenant_id, contact_id, channel, state, last_inbound_at, last_message_at)
    VALUES ($1,$2,'webchat','open','2026-10-01T12:00:00Z','2026-10-01T12:00:00Z')`, [tenant, contacto]);
  await withTenant(pool, tenant, async (c) => {
    await analyticsConsumers().find((x) => x.event === 'deal.won')!.handler({
      id: 901, name: 'deal.won', tenantId: tenant, payload: { valueClp: 15000 }, actor: 'system', requestId: null,
      version: 1, occurredAt: new Date('2026-10-01T12:00:00Z'),
    }, c);
    const vista = await getDashboard(c, { tenantId: tenant, from: '2000-01-01', to: '2100-01-01' });
    expect(vista.sinResponderAhora).toBe(1);
    expect(vista.metrics.ganadas).toBe(1);
    expect(vista.metrics.valor_ganado_clp).toBe(15000);
  });
});
