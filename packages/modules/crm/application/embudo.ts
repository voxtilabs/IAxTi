import type { PoolClient } from 'pg';

/**
 * El embudo que se puede leer (#695).
 *
 * `deals.won_at`, `deals.lost_at`, `deal_stage_history.from_stage_id` y
 * `.to_stage_id` se escribían desde el primer día y **ningún SELECT las
 * devolvía**. Son las cuatro columnas de las que sale todo lo que un vendedor
 * pregunta: cuánto demora ganar, dónde se cae la gente, qué etapa es el cuello.
 * Sin ellas el CRM muestra el presente del embudo y no puede decir si está
 * mejorando, que es la única razón para mirar un embudo dos veces.
 *
 * Vive en `crm` y no en `analytics` porque el dato es de `crm`: ponerlo allá
 * obligaba a consultar tablas ajenas (prohibido) o a declarar una dependencia
 * nueva entre módulos para leer lo que ya tiene dueño.
 *
 * Todo sale de la historia y no de contadores nuevos: la historia ya está
 * escrita, y un contador paralelo se desincroniza en el primer cambio manual.
 */

export interface EmbudoInput {
  tenantId: string;
  pipelineId: string;
  /** Cohorte: oportunidades CREADAS en el rango. `AAAA-MM-DD`, zona del negocio. */
  from?: string;
  to?: string;
  /** Solo las de este dueño (sin `crm.read_all`, las propias). */
  ownerId?: string | null;
}

export interface EtapaDelEmbudo {
  stageId: string;
  name: string;
  position: number;
  type: 'open' | 'won' | 'lost';
  /** Oportunidades distintas que ENTRARON a la etapa alguna vez. */
  entraron: number;
  /** De ésas, cuántas llegaron después a una etapa posterior. */
  avanzaron: number;
  /** `avanzaron / entraron`, o null si nunca entró nadie. */
  conversion: number | null;
  /** Cuántas se perdieron saliendo de acá. */
  perdidas: number;
}

export interface Embudo {
  etapas: EtapaDelEmbudo[];
  ciclo: {
    /** Oportunidades ganadas que entran en el promedio. */
    muestras: number;
    promedioDias: number | null;
    medianaDias: number | null;
  };
  /** La etapa donde se pierden más, si hay alguna pérdida. */
  seCaeEn: { stageId: string; name: string; perdidas: number } | null;
  /** Cuántas oportunidades de la cohorte, para distinguir "cero" de "sin datos". */
  oportunidades: number;
  definiciones: Record<string, string>;
}

export const DEFINICIONES_EMBUDO: Record<string, string> = {
  cohorte:
    'El embudo mira las oportunidades CREADAS en el rango y las sigue hasta hoy, aunque se hayan cerrado después. Por eso contesta si el embudo está mejorando: compara camadas, no instantes.',
  entraron:
    'Oportunidades distintas que pasaron por la etapa alguna vez. Volver a una etapa anterior es normal y cuenta una sola vez.',
  avanzaron:
    'De las que entraron, las que después llegaron a una etapa posterior. Una que retrocedió y volvió a avanzar cuenta como avanzada.',
  conversion: 'avanzaron ÷ entraron. Sin nadie que haya entrado, no hay porcentaje: queda vacío.',
  perdidas: 'Oportunidades que pasaron de esta etapa directo al cierre perdido.',
  ciclo:
    'Días entre crear la oportunidad y ganarla (won_at − created_at), sobre las ganadas de la cohorte.',
};

const SEGUNDOS_POR_DIA = 86_400;

function dias(segundos: unknown): number | null {
  if (segundos === null || segundos === undefined) return null;
  return Math.round((Number(segundos) / SEGUNDOS_POR_DIA) * 10) / 10;
}

export async function getEmbudo(client: PoolClient, input: EmbudoInput): Promise<Embudo> {
  // Un solo viaje a Postgres: el embudo se mira entero o no se mira.
  const r = await client.query(
    `WITH etapas AS (
       SELECT id, name, position, type FROM stages
        WHERE tenant_id = $1 AND pipeline_id = $2
     ), oportunidades AS (
       SELECT id, created_at, won_at, status FROM deals
        WHERE tenant_id = $1 AND pipeline_id = $2
          AND ($3::uuid IS NULL OR owner_id = $3)
          AND ($4::date IS NULL OR created_at >= $4::date)
          AND ($5::date IS NULL OR created_at < ($5::date + 1))
     ), pasos AS (
       SELECT h.deal_id, h.from_stage_id, h.to_stage_id, e.position AS to_pos, e.type AS to_type
         FROM deal_stage_history h
         JOIN etapas e ON e.id = h.to_stage_id
        WHERE h.tenant_id = $1 AND h.deal_id IN (SELECT id FROM oportunidades)
     ), tope AS (
       -- Hasta dónde llegó cada oportunidad. Con esto, retroceder de etapa no
       -- descuenta un avance que de verdad pasó.
       SELECT deal_id, max(to_pos) AS pos FROM pasos GROUP BY deal_id
     ), perdidas AS (
       SELECT from_stage_id AS stage_id, count(*)::int AS n
         FROM pasos WHERE to_type = 'lost' AND from_stage_id IS NOT NULL
        GROUP BY from_stage_id
     ), por_etapa AS (
       SELECT e.id, e.name, e.position, e.type,
              count(DISTINCT p.deal_id)::int AS entraron,
              count(DISTINCT p.deal_id) FILTER (WHERE t.pos > e.position)::int AS avanzaron,
              COALESCE(l.n, 0) AS perdidas
         FROM etapas e
         LEFT JOIN pasos p ON p.to_stage_id = e.id
         LEFT JOIN tope  t ON t.deal_id = p.deal_id
         LEFT JOIN perdidas l ON l.stage_id = e.id
        GROUP BY e.id, e.name, e.position, e.type, l.n
     ), ciclo AS (
       SELECT count(*)::int AS n,
              avg(extract(epoch FROM (won_at - created_at))) AS promedio,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY extract(epoch FROM (won_at - created_at))
              ) AS mediana
         FROM oportunidades WHERE status = 'won' AND won_at IS NOT NULL
     )
     SELECT COALESCE((SELECT jsonb_agg(por_etapa ORDER BY position) FROM por_etapa), '[]'::jsonb) AS etapas,
            (SELECT count(*)::int FROM oportunidades) AS total,
            ciclo.*
       FROM ciclo`,
    [input.tenantId, input.pipelineId, input.ownerId ?? null, input.from ?? null, input.to ?? null],
  );
  const fila = r.rows[0];
  const etapas: EtapaDelEmbudo[] = (
    fila.etapas as Array<Record<string, unknown>>
  ).map((e) => ({
    stageId: e.id as string,
    name: e.name as string,
    position: e.position as number,
    type: e.type as EtapaDelEmbudo['type'],
    entraron: e.entraron as number,
    avanzaron: e.avanzaron as number,
    conversion:
      (e.entraron as number) > 0
        ? Math.round(((e.avanzaron as number) / (e.entraron as number)) * 1000) / 1000
        : null,
    perdidas: e.perdidas as number,
  }));

  // La peor etapa, no la primera con pérdidas: empate se resuelve por posición
  // para que el número no baile entre dos consultas iguales.
  const caida = etapas
    .filter((e) => e.perdidas > 0)
    .sort((a, b) => b.perdidas - a.perdidas || a.position - b.position)[0];

  return {
    etapas,
    ciclo: {
      muestras: fila.n,
      promedioDias: dias(fila.promedio),
      medianaDias: dias(fila.mediana),
    },
    seCaeEn: caida ? { stageId: caida.stageId, name: caida.name, perdidas: caida.perdidas } : null,
    oportunidades: fila.total,
    definiciones: DEFINICIONES_EMBUDO,
  };
}

export interface PasoDeEtapa {
  from: { stageId: string; name: string } | null;
  to: { stageId: string; name: string };
  /** El motivo cuando lo hubo: obligatorio al retroceder y al perder. */
  reason: string | null;
  actor: string | null;
  at: Date;
  /** Verdadero cuando el movimiento fue hacia atrás. */
  backward: boolean;
}

/**
 * La historia de etapas de UNA oportunidad, para la ficha (#32).
 *
 * Es el otro lado de #695: `from_stage_id` y `to_stage_id` se escribían en cada
 * movimiento y la ficha no los mostraba, así que el retroceso con motivo
 * obligatorio quedaba guardado donde nadie lo leía.
 */
export async function historiaDeEtapas(
  client: PoolClient,
  input: { tenantId: string; dealId: string },
): Promise<PasoDeEtapa[]> {
  const r = await client.query(
    `SELECT h.from_stage_id, h.to_stage_id, h.reason, h.actor, h.created_at,
            o.name AS from_name, o.position AS from_pos,
            d.name AS to_name,   d.position AS to_pos
       FROM deal_stage_history h
       LEFT JOIN stages o ON o.id = h.from_stage_id
       JOIN stages d ON d.id = h.to_stage_id
      WHERE h.tenant_id = $1 AND h.deal_id = $2
      ORDER BY h.created_at, h.id`,
    [input.tenantId, input.dealId],
  );
  return r.rows.map((f) => ({
    from: f.from_stage_id ? { stageId: f.from_stage_id, name: f.from_name } : null,
    to: { stageId: f.to_stage_id, name: f.to_name },
    reason: f.reason ?? null,
    actor: f.actor ?? null,
    at: f.created_at,
    backward: f.from_pos !== null && f.to_pos < f.from_pos,
  }));
}
