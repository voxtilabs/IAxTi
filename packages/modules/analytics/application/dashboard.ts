import type { PoolClient } from 'pg';
import { DEFINICIONES, METRICS, TOTAL_OWNER, type Metric } from '../domain/metrics';

// El dashboard (#66): suma filas agregadas + dos consultas livianas en
// vivo (sin responder AHORA y percentiles sobre las muestras del rango).

export interface DashboardInput {
  tenantId: string;
  /** `AAAA-MM-DD`, ya en la zona del negocio. Texto a propósito: mandar un
   *  `Date` hace que Postgres lo convierta y el rango se corra un día. */
  from: string;
  to: string; // inclusive
  /** Filtra la vista a UN usuario (o el propio, si no tiene read_all). */
  ownerId?: string | null;
}

export interface DashboardResult {
  metrics: Record<Metric, number>;
  primeraRespuesta: { medianaSeg: number | null; p90Seg: number | null; muestras: number };
  sinResponderAhora: number;
  tasaCierre: number | null;
  porDia: Array<{ day: string; conversaciones: number; resueltas: number; oportunidades: number }>;
  definiciones: typeof DEFINICIONES;
}

export async function getDashboard(
  client: PoolClient,
  input: DashboardInput,
): Promise<DashboardResult> {
  const owner = input.ownerId ?? TOTAL_OWNER;
  const filas = await client.query(
    `SELECT metric, SUM(value)::numeric AS total FROM daily_metrics
      WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date AND owner_id = $4
      GROUP BY metric`,
    [input.tenantId, input.from, input.to, owner],
  );
  const metrics = Object.fromEntries(METRICS.map((m) => [m, 0])) as Record<Metric, number>;
  for (const fila of filas.rows) {
    if ((METRICS as readonly string[]).includes(fila.metric)) {
      metrics[fila.metric as Metric] = Number(fila.total);
    }
  }

  const muestras = await client.query(
    `SELECT count(*)::int AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS mediana,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY seconds) AS p90
       FROM response_samples
      WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date
        AND ($4::uuid = $5::uuid OR owner_id = $4)`,
    [input.tenantId, input.from, input.to, owner, TOTAL_OWNER],
  );
  const m = muestras.rows[0];

  const vivo = await client.query(
    `SELECT count(*)::int AS n FROM conversations
      WHERE tenant_id = $1 AND state IN ('new','open')
        AND last_inbound_at IS NOT NULL AND last_inbound_at = last_message_at
        AND ($2::uuid = $3::uuid OR owner_id = $2)`,
    [input.tenantId, owner, TOTAL_OWNER],
  );

  const cerradas = metrics.ganadas + metrics.perdidas;
  const porDia = await client.query(
    `SELECT day::text,
            SUM(value) FILTER (WHERE metric = 'conversaciones_nuevas')::int AS conversaciones,
            SUM(value) FILTER (WHERE metric = 'resueltas')::int AS resueltas,
            SUM(value) FILTER (WHERE metric = 'oportunidades_creadas')::int AS oportunidades
       FROM daily_metrics
      WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date AND owner_id = $4
      GROUP BY day ORDER BY day`,
    [input.tenantId, input.from, input.to, owner],
  );

  return {
    metrics,
    primeraRespuesta: {
      medianaSeg: m.mediana === null ? null : Math.round(Number(m.mediana)),
      p90Seg: m.p90 === null ? null : Math.round(Number(m.p90)),
      muestras: m.n,
    },
    sinResponderAhora: vivo.rows[0].n,
    tasaCierre: cerradas > 0 ? Math.round((metrics.ganadas / cerradas) * 1000) / 1000 : null,
    porDia: porDia.rows.map((d) => ({
      day: d.day,
      conversaciones: d.conversaciones ?? 0,
      resueltas: d.resueltas ?? 0,
      oportunidades: d.oportunidades ?? 0,
    })),
    definiciones: DEFINICIONES,
  };
}
