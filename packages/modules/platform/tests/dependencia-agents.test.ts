import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ModuleRegistry, CORE_MODULES } from '@iaxti/core';
import { createPool, runMigrations, topologicalOrder, findModulesDir } from '@iaxti/db';
import { aiExecutions, aiMetrics, promptsActivos } from '../application/centro-ia';

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
  tenant = (await pool.query("INSERT INTO tenants (name,plan,state) VALUES ($1,'crece','active') RETURNING id", ['dependencia-platform-agents'])).rows[0].id;
});
afterAll(async () => {
  for (const tabla of ["eval_runs", "agent_executions", "agents"]) {
    await pool.query(`DELETE FROM ${tabla} WHERE tenant_id=$1`, [tenant]);
  }
  await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]);
  await pool.end();
});

it('declara el cruce y registry/migraciones aceptan la misma composición', async () => {
  const registry = new ModuleRegistry().load();
  expect(registry.manifest('platform').depends_on?.optional).toContain('agents');
  expect(topologicalOrder(findModulesDir())).toEqual(registry.initOrder());
  expect(await runMigrations(pool)).toEqual([]); // repetición idempotente real
});

it('mantiene costo, ejecución y evaluación históricos con agents apagado', async () => {
  const registry = soloRequeridos();
  expect(registry.isActive('agents')).toBe(false);
  const agente = (await pool.query(`INSERT INTO agents (tenant_id, name, provider, model, prompt_name, prompt_version)
    VALUES ($1,'Demo','openai','modelo-fixture','demo','1') RETURNING id`, [tenant])).rows[0].id;
  await pool.query(`INSERT INTO agent_executions (tenant_id, agent_id, task, provider, model, input, cost_usd, status)
    VALUES ($1,$2,'sugerir','openai','modelo-fixture','{}',0.25,'ok')`, [tenant, agente]);
  await pool.query(`INSERT INTO eval_runs (tenant_id, agent_id, provider, model, case_count, scores, score)
    VALUES ($1,$2,'openai','modelo-fixture',1,'[]',0.8)`, [tenant, agente]);
  expect((await aiMetrics(pool, { tenantId: tenant }))[0]).toMatchObject({ ejecuciones: 1, costUsd: 0.25 });
  expect(await aiExecutions(pool, { tenantId: tenant })).toHaveLength(1);
  expect((await promptsActivos(pool, tenant))[0]).toMatchObject({ agentId: agente, ultimoScore: 0.8 });
});
