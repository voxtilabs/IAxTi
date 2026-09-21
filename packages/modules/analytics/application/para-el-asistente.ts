import type { PoolClient } from 'pg';
import { DEFINICIONES, METRICS, TOTAL_OWNER, type Metric } from '../domain/metrics';

/**
 * Los números, en la forma que necesita un asistente (#410).
 *
 * `getDashboard` devuelve el tablero entero, que es lo correcto para una
 * pantalla y lo peor posible para un modelo: recibe catorce números sin
 * pregunta y tiene que adivinar cuál le sirve.
 *
 * Acá van de a uno, con su definición al lado. La definición NO es adorno:
 * un asistente que recibe `ganadas: 7` y después tiene que explicar qué
 * significa "ganadas" lo va a inventar. Recibiéndola, la cita.
 *
 * Y lo que no se pudo medir vuelve en cero DICIENDO que es cero, nunca
 * ausente: un campo que falta se lee como "no sé" y un modelo rellena los
 * "no sé". Es la misma doctrina que el módulo ya tenía escrita — "lo que un
 * módulo apagado no puede medir aparece en cero con su explicación, jamás
 * adivinado" (SPEC §19).
 */

export interface MetricaParaElAsistente {
  metrica: string;
  valor: number;
  definicion: string;
  desde: string;
  hasta: string;
  /** Cómo leer el número: los `_clp` son pesos, los `_usd` dólares. */
  unidad: 'cantidad' | 'pesos' | 'dolares';
  /** Verdadero cuando NO hubo ningún dato en el rango, no cuando el total da cero. */
  sinDatos: boolean;
}

function unidadDe(metrica: string): MetricaParaElAsistente['unidad'] {
  if (metrica.endsWith('_clp')) return 'pesos';
  if (metrica.endsWith('_usd')) return 'dolares';
  return 'cantidad';
}

export function esMetrica(v: string): v is Metric {
  return (METRICS as readonly string[]).includes(v);
}

/** Qué se puede preguntar. Sin esto el modelo inventa nombres de métricas. */
export function catalogoDeMetricas(): Array<{ metrica: string; definicion: string; unidad: string }> {
  return METRICS.map((m) => ({
    metrica: m,
    definicion: DEFINICIONES[m],
    unidad: unidadDe(m),
  }));
}

export async function metricaEnRango(
  client: PoolClient,
  input: { tenantId: string; metrica: string; desde: string; hasta: string; ownerId?: string },
): Promise<MetricaParaElAsistente> {
  if (!esMetrica(input.metrica)) {
    // El error nombra las que SÍ existen: un modelo que recibe "no existe"
    // a secas vuelve a inventar en el siguiente intento.
    throw new Error(
      `No existe una métrica llamada "${input.metrica}". Las que hay: ${METRICS.join(', ')}.`,
    );
  }
  const r = await client.query(
    `SELECT COALESCE(SUM(value), 0)::numeric AS total, count(*)::int AS filas
       FROM daily_metrics
      WHERE tenant_id = $1 AND metric = $2
        AND day BETWEEN $3::date AND $4::date
        AND owner_id = $5`,
    [input.tenantId, input.metrica, input.desde, input.hasta, input.ownerId ?? TOTAL_OWNER],
  );
  const fila = r.rows[0];
  return {
    metrica: input.metrica,
    valor: Number(fila.total),
    definicion: DEFINICIONES[input.metrica],
    desde: input.desde,
    hasta: input.hasta,
    unidad: unidadDe(input.metrica),
    // Cero porque no pasó nada y cero porque nadie midió son cosas
    // distintas, y el dueño merece saber cuál de las dos.
    sinDatos: Number(fila.filas) === 0,
  };
}
