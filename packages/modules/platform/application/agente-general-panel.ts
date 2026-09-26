import type { Pool, PoolClient } from 'pg';
import { platformAudit } from './planes';

/**
 * El centro de control del Agente General (#496, ADR-0025).
 *
 * Es la pieza más crítica del producto: configura negocios ajenos
 * conversando. Por eso no alcanza con que funcione — hay que poder verlo y
 * poder apagarlo desde afuera, sin desplegar.
 *
 * El interruptor es SUYO y no el del módulo `agents`: apagar `agents` se
 * llevaría también al copiloto de la bandeja, que es lo que atiende
 * clientes. Apagar esto deja al producto como antes —pantallas y
 * configurador—, no a oscuras. Esa diferencia es la que permite usarlo a las
 * 2 de la mañana sin pensar.
 */

export interface EstadoDelApagado {
  apagado: boolean;
  /** `global` pesa más que `tenant`: si está apagado para todos, da igual lo otro. */
  alcance: 'global' | 'tenant' | null;
  motivo: string | null;
  apagadoEl: Date | null;
}

/**
 * ¿Está apagado para este negocio? Lo pregunta la API en cada conversación.
 *
 * Una sola consulta para los dos alcances, y el global gana: son dos filas
 * como máximo y partirlo en dos viajes solo agrega una carrera.
 */
export async function agenteGeneralApagado(
  client: Pick<PoolClient, 'query'>,
  tenantId: string,
): Promise<EstadoDelApagado> {
  const r = await client.query(
    `SELECT tenant_id, motivo, apagado_el FROM agente_general_apagado
      WHERE tenant_id IS NULL OR tenant_id = $1
      ORDER BY tenant_id NULLS FIRST LIMIT 1`,
    [tenantId],
  );
  if (r.rowCount === 0) return { apagado: false, alcance: null, motivo: null, apagadoEl: null };
  const f = r.rows[0];
  return {
    apagado: true,
    alcance: f.tenant_id === null ? 'global' : 'tenant',
    motivo: f.motivo as string,
    apagadoEl: f.apagado_el as Date,
  };
}

/**
 * Apaga el Agente General. `tenantId: null` lo apaga para todos.
 *
 * El motivo es obligatorio a propósito: un interruptor sin motivo, a los
 * tres días, nadie sabe si se puede volver a encender — y eso termina en un
 * producto apagado para siempre "por si acaso".
 */
export async function apagarAgenteGeneral(
  pool: Pick<Pool, 'query'>,
  input: { tenantId: string | null; motivo: string; adminUser: string },
): Promise<void> {
  const motivo = input.motivo?.trim();
  if (!motivo) throw new Error('Dinos por qué lo apagas: sin motivo nadie sabe después si se puede encender.');
  // Dos ramas y no un `ON CONFLICT` único: los dos índices son PARCIALES
  // —uno para la fila global y otro por tenant— y Postgres no resuelve un
  // upsert contra dos a la vez. Apagar dos veces tiene que actualizar el
  // motivo, no reventar con una clave duplicada justo cuando hay un
  // incidente.
  if (input.tenantId === null) {
    await pool.query('DELETE FROM agente_general_apagado WHERE tenant_id IS NULL');
    await pool.query(
      'INSERT INTO agente_general_apagado (tenant_id, motivo, apagado_por) VALUES (NULL, $1, $2)',
      [motivo, input.adminUser],
    );
  } else {
    await pool.query(
      `INSERT INTO agente_general_apagado (tenant_id, motivo, apagado_por)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) WHERE tenant_id IS NOT NULL
         DO UPDATE SET motivo = $2, apagado_por = $3, apagado_el = now()`,
      [input.tenantId, motivo, input.adminUser],
    );
  }
  await platformAudit(pool, input.adminUser, 'platform.agente_general.apagar', {
    tenantId: input.tenantId,
    motivo,
    alcance: input.tenantId === null ? 'global' : 'tenant',
  });
}

/** Lo vuelve a encender. Borrar la fila ES el encendido. */
export async function encenderAgenteGeneral(
  pool: Pick<Pool, 'query'>,
  input: { tenantId: string | null; adminUser: string },
): Promise<void> {
  await pool.query(
    input.tenantId === null
      ? 'DELETE FROM agente_general_apagado WHERE tenant_id IS NULL'
      : 'DELETE FROM agente_general_apagado WHERE tenant_id = $1',
    input.tenantId === null ? [] : [input.tenantId],
  );
  await platformAudit(pool, input.adminUser, 'platform.agente_general.encender', {
    tenantId: input.tenantId,
    alcance: input.tenantId === null ? 'global' : 'tenant',
  });
}

export interface CorridaDelAgente {
  id: string;
  tenantId: string;
  tenant: string;
  /** Lo último que le pidieron: el resto del hilo no se guarda. */
  pidio: string;
  herramientas: string[];
  costUsd: number | null;
  latencyMs: number | null;
  traceId: string | null;
  status: string;
  error: string | null;
  createdAt: Date;
}

/**
 * Las corridas del Agente General, de todos los negocios.
 *
 * Sale de `agent_executions` con `agent_id IS NULL` y la tarea propia: esa
 * combinación es exactamente "el Agente General y nadie más". Los
 * asistentes del tenant siempre tienen su `agent_id`.
 */
export async function corridasDelAgenteGeneral(
  client: Pick<PoolClient, 'query'>,
  input: { tenantId?: string; limite?: number } = {},
): Promise<CorridaDelAgente[]> {
  const r = await client.query(
    `SELECT e.id, e.tenant_id, t.name AS tenant, e.input, e.output, e.cost_usd,
            e.latency_ms, e.trace_id, e.status, e.error, e.created_at
       FROM agent_executions e
       JOIN tenants t ON t.id = e.tenant_id
      WHERE e.agent_id IS NULL AND e.task = 'configuracion_conversada'
        AND ($1::uuid IS NULL OR e.tenant_id = $1)
      ORDER BY e.created_at DESC
      LIMIT $2`,
    [input.tenantId ?? null, Math.min(input.limite ?? 50, 200)],
  );
  return r.rows.map((f) => ({
    id: f.id as string,
    tenantId: f.tenant_id as string,
    tenant: f.tenant as string,
    pidio: ((f.input as { ultima?: string })?.ultima ?? '').slice(0, 300),
    herramientas: ((f.output as { pasos?: string[] })?.pasos ?? []) as string[],
    costUsd: f.cost_usd === null ? null : Number(f.cost_usd),
    latencyMs: f.latency_ms === null ? null : Number(f.latency_ms),
    traceId: (f.trace_id as string) ?? null,
    status: f.status as string,
    error: (f.error as string) ?? null,
    createdAt: f.created_at as Date,
  }));
}

export interface ResumenDelAgente {
  corridasDelMes: number;
  costoDelMesUsd: number;
  /** Fallidas sobre el total: si esto sube, algo pasa y hay que mirarlo. */
  tasaDeError: number;
  /** Cuántos negocios lo usaron este mes. */
  negocios: number;
  /** El p95 y no el promedio: el promedio esconde justo la cola que molesta. */
  latenciaP95Ms: number | null;
  apagadoGlobal: EstadoDelApagado;
  /** Los negocios apagados uno por uno, con su motivo. */
  apagadosPorNegocio: Array<{ tenantId: string; tenant: string; motivo: string; apagadoEl: Date }>;
}

export async function resumenDelAgenteGeneral(
  client: Pick<PoolClient, 'query'>,
  /** Sin tenant, la plataforma entera; con tenant, ese negocio. */
  input: { tenantId?: string } = {},
): Promise<ResumenDelAgente> {
  const r = await client.query(
    `SELECT count(*)::int AS corridas,
            COALESCE(sum(cost_usd), 0)::float AS costo,
            count(*) FILTER (WHERE status <> 'ok')::int AS fallidas,
            count(DISTINCT tenant_id)::int AS negocios,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
       FROM agent_executions
      WHERE agent_id IS NULL AND task = 'configuracion_conversada'
        AND created_at >= date_trunc('month', now())
        AND ($1::uuid IS NULL OR tenant_id = $1)`,
    [input.tenantId ?? null],
  );
  const f = r.rows[0];
  const corridas = Number(f.corridas);
  const apagados = await client.query(
    `SELECT a.tenant_id, t.name AS tenant, a.motivo, a.apagado_el
       FROM agente_general_apagado a JOIN tenants t ON t.id = a.tenant_id
      WHERE a.tenant_id IS NOT NULL ORDER BY a.apagado_el DESC`,
  );
  const global = await client.query(
    'SELECT motivo, apagado_el FROM agente_general_apagado WHERE tenant_id IS NULL',
  );
  return {
    corridasDelMes: corridas,
    costoDelMesUsd: Number(f.costo),
    // Sin corridas la tasa es 0 y no NaN: un tablero que muestra NaN se lee
    // como que el tablero está roto, no como que no pasó nada.
    tasaDeError: corridas === 0 ? 0 : Number(f.fallidas) / corridas,
    negocios: Number(f.negocios),
    latenciaP95Ms: f.p95 === null ? null : Number(f.p95),
    apagadoGlobal:
      global.rowCount === 0
        ? { apagado: false, alcance: null, motivo: null, apagadoEl: null }
        : {
            apagado: true,
            alcance: 'global',
            motivo: global.rows[0].motivo as string,
            apagadoEl: global.rows[0].apagado_el as Date,
          },
    apagadosPorNegocio: apagados.rows.map((a) => ({
      tenantId: a.tenant_id as string,
      tenant: a.tenant as string,
      motivo: a.motivo as string,
      apagadoEl: a.apagado_el as Date,
    })),
  };
}
