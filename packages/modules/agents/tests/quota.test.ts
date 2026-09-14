import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  afterExecutionQuota,
  costPerDay,
  costThisCycle,
  getQuota,
  isAutonomousPaused,
} from '../application/quota';
import { createAgent } from '../application/agents';
import { runAgentTask } from '../application/runtime';
import type { ModelPortFactory } from '../application/models';
import type { Agent } from '../application/agents';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let agente: Agent;

const fakeFactory: ModelPortFactory = (provider, model) => ({
  async generate() {
    return { text: `ok ${provider}/${model}`, tokensIn: 100, tokensOut: 20 };
  },
});

async function fijarUso(valor: number): Promise<void> {
  await admin.query(
    `INSERT INTO usage_meters (tenant_id, metric, period_start, value)
     VALUES ($1, 'ia_executions', date_trunc('month', now())::date, $2)
     ON CONFLICT (tenant_id, metric, period_start) DO UPDATE SET value = $2`,
    [tenant, valor],
  );
}

async function eventos(nombre: string): Promise<Array<Record<string, unknown>>> {
  const r = await admin.query(
    'SELECT payload FROM outbox WHERE name = $1 AND tenant_id = $2 ORDER BY id',
    [nombre, tenant],
  );
  return r.rows.map((row) => row.payload);
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('quota-ia-test') RETURNING id");
  tenant = t.rows[0].id;
  // Plan base: 1000 ia_executions_month (plan_limits seed).
  await admin.query(`UPDATE tenants SET plan = 'base' WHERE id = $1`, [tenant]);
  agente = await withTenant(admin, tenant, (c) =>
    createAgent(c, {
      tenantId: tenant,
      name: 'Sofía',
      defaultMode: 'autonomous',
      fallbackSystemPrompt: 'Eres Sofía.',
      actor: 'test',
    }),
  );
});

afterAll(async () => {
  await admin.query('DELETE FROM agent_quota_alerts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM agent_executions WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM agents WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM usage_meters WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

describe('cuota de IA (#52)', () => {
  it('el tope viene del plan EN VIVO: cambiar de plan recalcula solo', async () => {
    const base = await withTenant(admin, tenant, (c) => getQuota(c, tenant));
    expect(base.limit).toBe(1000); // plan base
    await admin.query(`UPDATE tenants SET plan = 'crece' WHERE id = $1`, [tenant]);
    const crece = await withTenant(admin, tenant, (c) => getQuota(c, tenant));
    expect(crece.limit).toBe(4000); // sin snapshot que migrar
    await admin.query(`UPDATE tenants SET plan = 'base' WHERE id = $1`, [tenant]);
  });

  it('cruza el 80 % UNA sola vez por ciclo y publica el evento', async () => {
    await fijarUso(820);
    const primera = await withTenant(admin, tenant, (c) => afterExecutionQuota(c, tenant));
    expect(primera.alerted).toEqual([80]);
    const segunda = await withTenant(admin, tenant, (c) => afterExecutionQuota(c, tenant));
    expect(segunda.alerted).toEqual([]); // idempotente por ciclo
    const avisos = await eventos('agent.quota_threshold');
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ level: 80, limit: 1000 });
  });

  it('al 100 % avisa y PAUSA el modo autónomo', async () => {
    await fijarUso(1000);
    const res = await withTenant(admin, tenant, (c) => afterExecutionQuota(c, tenant));
    expect(res.alerted).toEqual([100]);
    expect(await withTenant(admin, tenant, (c) => isAutonomousPaused(c, tenant, agente.id))).toBe(true);
    const avisos = await eventos('agent.quota_threshold');
    expect(avisos.map((a) => a.level)).toEqual([80, 100]);
  });

  it('agotada y SIN económico: la corrida se rechaza sin gastar, con explicación', async () => {
    const res = await withTenant(admin, tenant, (c) =>
      runAgentTask(
        c,
        { tenantId: tenant, agent: agente, task: 'sugerir', prompt: 'hola' },
        fakeFactory,
      ),
    );
    expect(res.status).toBe('failed');
    expect(res.error).toContain('cuota de IA del mes');
    expect(res.tokensIn).toBe(0); // ni un token gastado
    const uso = await withTenant(admin, tenant, (c) => getQuota(c, tenant));
    expect(uso.used).toBe(1000); // no incrementó
  });

  it('agotada CON económico configurado: assist sigue con el modelo barato', async () => {
    await admin.query(
      `UPDATE tenants SET settings = settings ||
        '{"ia":{"economico":{"provider":"glm","model":"glm-4.6"}}}'::jsonb
       WHERE id = $1`,
      [tenant],
    );
    const res = await withTenant(admin, tenant, (c) =>
      runAgentTask(
        c,
        { tenantId: tenant, agent: agente, task: 'sugerir', prompt: 'hola de nuevo' },
        fakeFactory,
      ),
    );
    expect(res.status).toBe('ok');
    expect(res.degraded).toBe(true);
    expect(res.provider).toBe('glm');
    expect(res.model).toBe('glm-4.6');
    const fila = await admin.query(
      'SELECT explanation FROM agent_executions WHERE id = $1',
      [res.executionId],
    );
    expect(fila.rows[0].explanation).toContain('económico');
    await admin.query(`UPDATE tenants SET settings = '{}'::jsonb WHERE id = $1`, [tenant]);
  });

  it('el costo por ciclo y por día alimenta la alerta de fuera de rango', async () => {
    const ciclo = await withTenant(admin, tenant, (c) => costThisCycle(c, tenant));
    expect(ciclo).toBeGreaterThan(0); // la corrida económica costó algo
    const dias = await withTenant(admin, tenant, (c) => costPerDay(c, tenant, 7));
    expect(dias.length).toBeGreaterThanOrEqual(1);
    expect(dias[0].executions).toBeGreaterThanOrEqual(1);
  });
});
