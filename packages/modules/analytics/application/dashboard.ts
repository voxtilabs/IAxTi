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

/**
 * El MISMO largo de ventana, pegado justo antes de `from` (#588, punto 5).
 *
 * Una cifra sola no se puede leer: «142 conversaciones» no dice si el negocio
 * está bien o mal. Lo que se compara tiene que ser comparable, así que el
 * período anterior se calcula del largo del rango pedido y no de un «mes
 * pasado» fijo: pedir 7 días compara contra los 7 anteriores, pedir 30 contra
 * los 30 anteriores.
 *
 * Viene con sus fechas. La tarjeta tiene que poder decir «vs 1–7 oct» y no «vs
 * la semana pasada»: contra qué se compara es parte del número, y si el que
 * lee tiene que adivinar el rango, la comparación no le sirve para decidir.
 */
export interface PeriodoAnterior {
  from: string;
  to: string;
  metrics: Record<Metric, number>;
  tasaCierre: number | null;
  /** Sin p90: en una tarjeta de comparación el p90 es ruido, y devolver un
   *  número que nadie va a pintar invita a pintarlo sin saber qué es. */
  primeraRespuesta: { medianaSeg: number | null; muestras: number };
  /**
   * `false` cuando el período anterior empieza antes del primer día con datos
   * del negocio.
   *
   * Sin esto, un tenant que arrancó el lunes compara su primera semana contra
   * una ventana donde todavía no existía, y la tarjeta anuncia un «+100 %»
   * glorioso que en realidad dice «antes no había nada». Cero y no-hubo-datos
   * se ven iguales en un SUM y no significan lo mismo: el primero es un dato,
   * el segundo es la falta de uno. Quien pinta la tarjeta necesita poder
   * escribir «sin comparación» en vez de inventar un porcentaje.
   */
  comparable: boolean;
}

export interface DashboardResult {
  metrics: Record<Metric, number>;
  primeraRespuesta: { medianaSeg: number | null; p90Seg: number | null; muestras: number };
  sinResponderAhora: number;
  tasaCierre: number | null;
  porDia: Array<{ day: string; conversaciones: number; resueltas: number; oportunidades: number }>;
  definiciones: typeof DEFINICIONES;
  /** `sinResponderAhora` NO entra acá a propósito: es una foto de este
   *  instante, no un total del período, y compararlo contra «el mes pasado»
   *  sería comparar un semáforo con un promedio. */
  anterior: PeriodoAnterior;
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
     ), rango_antes AS (
       -- El largo se calcula en Postgres y no en JS: mandar otro par de fechas
       -- desde el controlador abre la puerta a que el «anterior» tenga un
       -- largo distinto al pedido, y ahí la comparación miente sin avisar.
       SELECT ($2::date - ($3::date - $2::date + 1)) AS desde, ($2::date - 1) AS hasta
     ), diarias_antes AS MATERIALIZED (
       SELECT dm.metric, dm.value
         FROM daily_metrics dm, rango_antes r
        WHERE dm.tenant_id = $1 AND dm.day BETWEEN r.desde AND r.hasta AND dm.owner_id = $4
     ), totales_antes AS (
       SELECT metric, SUM(value)::numeric AS total FROM diarias_antes GROUP BY metric
     ), muestras_antes AS (
       SELECT count(*)::int AS n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS mediana
         FROM response_samples rs, rango_antes r
        WHERE rs.tenant_id = $1 AND rs.day BETWEEN r.desde AND r.hasta
          AND ($4::uuid = $5::uuid OR rs.owner_id = $4)
     ), primer_dia AS (
       -- El día más viejo con datos, para saber si el período anterior cae
       -- antes de que este negocio existiera.
       SELECT MIN(day) AS day FROM daily_metrics WHERE tenant_id = $1 AND owner_id = $4
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
            (SELECT desde::text FROM rango_antes) AS antes_desde,
            (SELECT hasta::text FROM rango_antes) AS antes_hasta,
            COALESCE((SELECT jsonb_object_agg(metric, total) FROM totales_antes), '{}'::jsonb) AS metrics_antes,
            (SELECT n FROM muestras_antes) AS antes_n,
            (SELECT mediana FROM muestras_antes) AS antes_mediana,
            (SELECT day IS NOT NULL AND day <= (SELECT desde FROM rango_antes) FROM primer_dia) AS comparable,
            muestras.*
       FROM muestras`,
    [input.tenantId, input.from, input.to, owner, TOTAL_OWNER],
  );
  const fila = resultado.rows[0];
  const metrics = Object.fromEntries(METRICS.map((metric) => [
    metric, Number(fila.metrics[metric] ?? 0),
  ])) as Record<Metric, number>;
  const cerradas = metrics.ganadas + metrics.perdidas;
  const metricsAntes = Object.fromEntries(METRICS.map((metric) => [
    metric, Number(fila.metrics_antes[metric] ?? 0),
  ])) as Record<Metric, number>;
  const cerradasAntes = metricsAntes.ganadas + metricsAntes.perdidas;

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
    anterior: {
      from: fila.antes_desde,
      to: fila.antes_hasta,
      metrics: metricsAntes,
      tasaCierre:
        cerradasAntes > 0
          ? Math.round((metricsAntes.ganadas / cerradasAntes) * 1000) / 1000
          : null,
      primeraRespuesta: {
        medianaSeg: fila.antes_mediana === null ? null : Math.round(Number(fila.antes_mediana)),
        muestras: fila.antes_n,
      },
      // `MIN(day)` de una tabla vacía es NULL, y el `IS NOT NULL` de la
      // consulta ya lo convierte en `false`. El `=== true` es por el caso en
      // que la subconsulta entera no devuelva fila.
      comparable: fila.comparable === true,
    },
  };
}
