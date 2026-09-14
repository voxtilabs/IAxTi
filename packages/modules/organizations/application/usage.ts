import type { PoolClient } from 'pg';

export type UsageMetric = 'conversations' | 'ia_executions' | 'storage_mb' | 'api_requests';

/** Inicio del ciclo mensual del período que contiene `at`. */
export function periodStart(at = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Los medidores se actualizan por evento (upsert atómico); la consolidación
 * horaria del SPEC agrega sobre esta misma tabla. Umbrales (80 %, 100 %) se
 * evalúan contra plan_limits al consumir el evento (llega con outbox, #13).
 */
export async function incrementUsage(
  client: PoolClient,
  tenantId: string,
  metric: UsageMetric,
  amount = 1,
  at = new Date(),
): Promise<number> {
  const result = await client.query(
    `INSERT INTO usage_meters (tenant_id, metric, period_start, value)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, metric, period_start)
     DO UPDATE SET value = usage_meters.value + EXCLUDED.value, updated_at = now()
     RETURNING value`,
    [tenantId, metric, periodStart(at), amount],
  );
  return Number(result.rows[0].value);
}

export async function getUsage(
  client: PoolClient,
  tenantId: string,
  metric: UsageMetric,
  at = new Date(),
): Promise<number> {
  const result = await client.query(
    'SELECT value FROM usage_meters WHERE tenant_id = $1 AND metric = $2 AND period_start = $3',
    [tenantId, metric, periodStart(at)],
  );
  return result.rowCount === 0 ? 0 : Number(result.rows[0].value);
}

/**
 * El tope mensual de requests de la API (#25): override del SuperAdmin
 * (settings.api.requestsMonthOverride) o el del plan. null = sin plan
 * conocido (no se corta, pero tampoco se promete infinito).
 */
export async function apiRequestsLimit(
  client: PoolClient,
  tenantId: string,
): Promise<number | null> {
  const r = await client.query(
    `SELECT t.settings->'api'->>'requestsMonthOverride' AS override, pl.api_requests_month
       FROM tenants t LEFT JOIN plan_limits pl ON pl.plan = t.plan
      WHERE t.id = $1`,
    [tenantId],
  );
  if (r.rowCount === 0) return null;
  const override = Number(r.rows[0].override);
  if (Number.isFinite(override) && override > 0) return override;
  const delPlan = r.rows[0].api_requests_month;
  return delPlan === null ? null : Number(delPlan);
}
