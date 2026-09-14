import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { getUsage, periodStart } from '@iaxti/module-organizations';

// La cuota de IA (#52, SPEC §13/§40): los tokens son uno de los dos únicos
// costos variables — sin cuota, un tenant quema el margen del mes en un día.

export interface QuotaState {
  used: number;
  /** null = ilimitada (el plan no fija tope). */
  limit: number | null;
  pct: number | null;
  exhausted: boolean;
}

/** El tope viene del PLAN en vivo (plan_limits): cambiar de plan recalcula
 *  solo, sin snapshot que migrar. */
export async function getQuota(client: PoolClient, tenantId: string): Promise<QuotaState> {
  const r = await client.query(
    `SELECT pl.ia_executions_month AS limit
       FROM tenants t LEFT JOIN plan_limits pl ON pl.plan = t.plan
      WHERE t.id = $1`,
    [tenantId],
  );
  const limit = r.rows[0]?.limit ?? null;
  const used = await getUsage(client, tenantId, 'ia_executions');
  const pct = limit ? Math.floor((used / limit) * 100) : null;
  return { used, limit, pct, exhausted: limit !== null && used >= limit };
}

/**
 * Tras cada ejecución: publica agent.quota_threshold al cruzar 80 y 100 —
 * UNA vez por ciclo y nivel (agent_quota_alerts). Al 100 %, el modo
 * autónomo SE PAUSA (las conversaciones vuelven a assist); nada vuelve a
 * autónomo solo.
 */
export async function afterExecutionQuota(
  client: PoolClient,
  tenantId: string,
  requestId?: string,
): Promise<{ alerted: number[] }> {
  const quota = await getQuota(client, tenantId);
  if (quota.limit === null || quota.pct === null) return { alerted: [] };
  const alerted: number[] = [];
  const period = periodStart();
  for (const level of [80, 100] as const) {
    if (quota.pct < level) continue;
    const inserted = await client.query(
      `INSERT INTO agent_quota_alerts (tenant_id, period_start, level)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING level`,
      [tenantId, period, level],
    );
    if ((inserted.rowCount ?? 0) === 0) continue;
    alerted.push(level);
    await publishEvent(client, {
      name: 'agent.quota_threshold',
      tenantId,
      payload: { level, used: quota.used, limit: quota.limit },
      actor: 'system',
      requestId,
    });
    if (level === 100) {
      await client.query(
        `UPDATE agents SET autonomous_paused_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND default_mode = 'autonomous' AND autonomous_paused_at IS NULL`,
        [tenantId],
      );
    }
  }
  return { alerted };
}

/** ¿El autónomo está pausado por cuota? (#49 lo consulta antes de actuar.) */
export async function isAutonomousPaused(
  client: PoolClient,
  tenantId: string,
  agentId: string,
): Promise<boolean> {
  const r = await client.query(
    'SELECT autonomous_paused_at FROM agents WHERE tenant_id = $1 AND id = $2',
    [tenantId, agentId],
  );
  return Boolean(r.rows[0]?.autonomous_paused_at);
}

/** Costo estimado por día (USD): alimenta la alerta de "fuera de rango". */
export async function costPerDay(
  client: PoolClient,
  tenantId: string,
  days = 30,
): Promise<Array<{ day: string; costUsd: number; executions: number }>> {
  const r = await client.query(
    `SELECT date_trunc('day', created_at)::date AS day,
            COALESCE(sum(cost_usd), 0) AS cost, count(*)::int AS n
       FROM agent_executions
      WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2)
      GROUP BY 1 ORDER BY 1 DESC`,
    [tenantId, Math.min(days, 90)],
  );
  return r.rows.map((row) => ({
    day: row.day.toISOString().slice(0, 10),
    costUsd: Number(row.cost),
    executions: row.n,
  }));
}

/** Costo del ciclo actual (USD), para "pesos para el dueño". */
export async function costThisCycle(client: PoolClient, tenantId: string): Promise<number> {
  const r = await client.query(
    `SELECT COALESCE(sum(cost_usd), 0) AS cost FROM agent_executions
      WHERE tenant_id = $1 AND created_at >= $2`,
    [tenantId, periodStart()],
  );
  return Number(r.rows[0].cost);
}
