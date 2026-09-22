import type { PoolClient } from 'pg';
import { DEFINICIONES, METRICS, TOTAL_OWNER, type Metric } from '../domain/metrics';

// El dashboard (#66/#424): agregados diarios y lecturas en vivo de
// pendientes/percentiles, en un único viaje a la base.

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
  // Una sola ida a Postgres (#424): las cuatro consultas anteriores
  // acumulaban la latencia de red incluso con tres días de datos. El CTE
  // comparte las filas agregadas entre totales y serie; todas las métricas
  // se leen además sobre el mismo snapshot, sin caché de datos del negocio.
  const resultado = await client.query(
    `WITH diarias AS MATERIALIZED (
       SELECT day, metric, value FROM daily_metrics
        WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date AND owner_id = $4
     ), totales AS (
       SELECT metric, SUM(value)::numeric AS total FROM diarias GROUP BY metric
     ), por_dia AS (
       SELECT day::text,
              COALESCE(SUM(value) FILTER (WHERE metric = 'conversaciones_nuevas'), 0)::int AS conversaciones,
              COALESCE(SUM(value) FILTER (WHERE metric = 'resueltas'), 0)::int AS resueltas,
              COALESCE(SUM(value) FILTER (WHERE metric = 'oportunidades_creadas'), 0)::int AS oportunidades
         FROM diarias GROUP BY day
     ), muestras AS (
       SELECT count(*)::int AS n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS mediana,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY seconds) AS p90
         FROM response_samples
        WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date
          AND ($4::uuid = $5::uuid OR owner_id = $4)
     )
     SELECT COALESCE((SELECT jsonb_object_agg(metric, total) FROM totales), '{}'::jsonb) AS metrics,
            COALESCE((SELECT jsonb_agg(por_dia ORDER BY day) FROM por_dia), '[]'::jsonb) AS por_dia,
            (SELECT count(*)::int FROM conversations
              WHERE tenant_id = $1 AND state IN ('new','open')
                AND last_inbound_at IS NOT NULL AND last_inbound_at = last_message_at
                AND ($4::uuid = $5::uuid OR owner_id = $4)) AS sin_responder,
            muestras.*
       FROM muestras`,
    [input.tenantId, input.from, input.to, owner, TOTAL_OWNER],
  );
  const fila = resultado.rows[0];
  const metrics = Object.fromEntries(METRICS.map((metric) => [
    metric, Number(fila.metrics[metric] ?? 0),
  ])) as Record<Metric, number>;
  const cerradas = metrics.ganadas + metrics.perdidas;

  return {
    metrics,
    primeraRespuesta: {
      medianaSeg: fila.mediana === null ? null : Math.round(Number(fila.mediana)),
      p90Seg: fila.p90 === null ? null : Math.round(Number(fila.p90)),
      muestras: fila.n,
    },
    sinResponderAhora: fila.sin_responder,
    tasaCierre: cerradas > 0 ? Math.round((metrics.ganadas / cerradas) * 1000) / 1000 : null,
    porDia: fila.por_dia,
    definiciones: DEFINICIONES,
  };
}
