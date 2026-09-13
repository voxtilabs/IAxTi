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
