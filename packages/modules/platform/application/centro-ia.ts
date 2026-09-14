import type { Pool } from 'pg';

// Centro de IA del SuperAdmin (#70, prompt maestro §22). Con varios modelos
// en producción, el costo por modelo y por tenant es lo que dice si el
// ahorro es real y si alguien se está saliendo de rango.
//
// La fuente es `agent_executions`, que es NUESTRA tabla y la que factura.
// A Langfuse no se le piden agregados: ya los tenemos, y pedirlos dos veces
// sería tener dos verdades. Langfuse es el enlace profundo al trace, a la
// generación y a la tool call — que es justo lo que no guardamos.

export type Agrupacion = 'dia' | 'tenant' | 'modelo' | 'agente' | 'tarea';

const COLUMNA: Record<Agrupacion, string> = {
  dia: "date_trunc('day', e.created_at)::date::text",
  tenant: 'e.tenant_id::text',
  modelo: "e.provider || '/' || e.model",
  agente: 'COALESCE(e.agent_id::text, sin_agente)',
  tarea: 'e.task',
};

export interface FilaIA {
  clave: string;
  ejecuciones: number;
  fallidas: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  costClp: number;
  latenciaP50: number | null;
  latenciaP95: number | null;
  exitoPct: number;
}

export interface MetricasInput {
  desde?: Date;
  hasta?: Date;
  tenantId?: string;
  groupBy?: Agrupacion;
  /** Tipo de cambio para mostrar pesos; lo trae quien llama (billing). */
  usdClp?: number;
  limit?: number;
}

/**
 * Métricas agregadas. El p95 importa más que el promedio: un agente que
 * responde rápido casi siempre y se cuelga una de cada veinte se ve normal
 * en la media y pésimo en la práctica.
 */
export async function aiMetrics(pool: Pool, input: MetricasInput = {}): Promise<FilaIA[]> {
  const usdClp = input.usdClp ?? 0;
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clausula: string, valor: unknown) => {
    params.push(valor);
    where.push(clausula.replace('?', `$${params.length}`));
  };
  if (input.tenantId) add('e.tenant_id = ?', input.tenantId);
  if (input.desde) add('e.created_at >= ?', input.desde);
  if (input.hasta) add('e.created_at <= ?', input.hasta);
  params.push(Math.min(input.limit ?? 100, 500));

  const columna = COLUMNA[input.groupBy ?? 'dia'].replace('sin_agente', "'(sin agente)'");
  const sql = `
    SELECT ${columna} AS clave,
           count(*)::int AS ejecuciones,
           count(*) FILTER (WHERE e.status = 'failed')::int AS fallidas,
           COALESCE(sum(e.tokens_in), 0)::int AS tokens_in,
           COALESCE(sum(e.tokens_out), 0)::int AS tokens_out,
           COALESCE(sum(e.cost_usd), 0)::numeric AS cost_usd,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY e.latency_ms) AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY e.latency_ms) AS p95
      FROM agent_executions e
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     GROUP BY 1
     ORDER BY 1 DESC
     LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  return r.rows.map((row) => {
    const ejecuciones = row.ejecuciones as number;
    const fallidas = row.fallidas as number;
    const costUsd = Number(row.cost_usd);
    return {
      clave: String(row.clave),
      ejecuciones,
      fallidas,
      tokensIn: row.tokens_in as number,
      tokensOut: row.tokens_out as number,
      costUsd,
      costClp: Math.round(costUsd * usdClp),
      latenciaP50: row.p50 === null ? null : Math.round(Number(row.p50)),
      latenciaP95: row.p95 === null ? null : Math.round(Number(row.p95)),
      exitoPct: ejecuciones === 0 ? 100 : Math.round(((ejecuciones - fallidas) / ejecuciones) * 100),
    };
  });
}

/**
 * El enlace al trace en Langfuse. Sin `LANGFUSE_BASE_URL` no se inventa una
 * URL: se devuelve null y la UI muestra el id, que igual sirve para buscar.
 */
export function traceUrl(traceId: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!traceId) return null;
  const base = env.LANGFUSE_BASE_URL ?? (env.LANGFUSE_PUBLIC_KEY ? 'https://cloud.langfuse.com' : null);
  if (!base) return null;
  const proyecto = env.LANGFUSE_PROJECT_ID;
  return proyecto
    ? `${base.replace(/\/$/, '')}/project/${proyecto}/traces/${traceId}`
    : `${base.replace(/\/$/, '')}/trace/${traceId}`;
}

export interface EjecucionIA {
  id: string;
  tenantId: string;
  agentId: string | null;
  task: string;
  provider: string;
  model: string;
  status: string;
  costUsd: number;
  latencyMs: number | null;
  traceId: string | null;
  traceUrl: string | null;
  conversationId: string | null;
  createdAt: string;
}

/**
 * Las últimas ejecuciones, con el camino completo hacia el detalle:
 * tenant → conversación → ejecución → trace. La conversación sale del
 * input de la ejecución, que es donde el runtime la deja.
 */
export async function aiExecutions(
  pool: Pool,
  input: { tenantId?: string; model?: string; soloFallidas?: boolean; limit?: number } = {},
): Promise<EjecucionIA[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clausula: string, valor: unknown) => {
    params.push(valor);
    where.push(clausula.replace('?', `$${params.length}`));
  };
  if (input.tenantId) add('tenant_id = ?', input.tenantId);
  if (input.model) add("(provider || '/' || model) = ?", input.model);
  if (input.soloFallidas) where.push("status = 'failed'");
  params.push(Math.min(input.limit ?? 50, 200));

  const r = await pool.query(
    `SELECT id, tenant_id, agent_id, task, provider, model, status,
            COALESCE(cost_usd, 0) AS cost_usd, latency_ms, trace_id,
            input->>'conversationId' AS conversation_id, created_at
       FROM agent_executions
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((row) => ({
    id: row.id as string,
    tenantId: row.tenant_id as string,
    agentId: (row.agent_id as string) ?? null,
    task: row.task as string,
    provider: row.provider as string,
    model: row.model as string,
    status: row.status as string,
    costUsd: Number(row.cost_usd),
    latencyMs: (row.latency_ms as number) ?? null,
    traceId: (row.trace_id as string) ?? null,
    traceUrl: traceUrl((row.trace_id as string) ?? null),
    conversationId: (row.conversation_id as string) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  }));
}

export interface PromptActivo {
  tenantId: string;
  agentId: string;
  nombre: string;
  promptName: string | null;
  promptVersion: string | null;
  /** Último score de evaluación del tenant, si corrió alguna (#53). */
  ultimoScore: number | null;
  ultimaEvalAt: string | null;
}

/** Qué prompt está vivo en cada agente y cómo le fue en la última evaluación. */
export async function promptsActivos(pool: Pool, tenantId?: string): Promise<PromptActivo[]> {
  const r = await pool.query(
    `SELECT a.tenant_id, a.id AS agent_id, a.name, a.prompt_name, a.prompt_version,
            ev.score AS ultimo_score, ev.created_at AS ultima_eval
       FROM agents a
       LEFT JOIN LATERAL (
         SELECT score, created_at FROM eval_runs r
          WHERE r.tenant_id = a.tenant_id
          ORDER BY created_at DESC LIMIT 1
       ) ev ON true
      ${tenantId ? 'WHERE a.tenant_id = $1' : ''}
      ORDER BY a.tenant_id, a.name
      LIMIT 200`,
    tenantId ? [tenantId] : [],
  );
  return r.rows.map((row) => ({
    tenantId: row.tenant_id as string,
    agentId: row.agent_id as string,
    nombre: row.name as string,
    promptName: (row.prompt_name as string) ?? null,
    promptVersion: (row.prompt_version as string) ?? null,
    ultimoScore: row.ultimo_score === null ? null : Number(row.ultimo_score),
    ultimaEvalAt: row.ultima_eval ? (row.ultima_eval as Date).toISOString() : null,
  }));
}

export interface AlertaCosto {
  tenantId: string;
  nombre: string;
  plan: string;
  costUsdCiclo: number;
  costClpCiclo: number;
  presupuestoUsd: number | null;
  pct: number | null;
  nivel: 'ok' | 'atencion' | 'excedido';
}

/**
 * Quién se sale de rango este ciclo. El presupuesto sale del plan; sin tope
 * declarado no se inventa uno — se informa el gasto y listo, que es más
 * honesto que compararlo contra un número imaginario.
 */
export async function alertasCosto(
  pool: Pool,
  input: { usdClp?: number; desde?: Date; umbralPct?: number } = {},
): Promise<AlertaCosto[]> {
  const usdClp = input.usdClp ?? 0;
  const umbral = input.umbralPct ?? 80;
  const desde = input.desde ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const r = await pool.query(
    `SELECT t.id, t.name, t.plan,
            COALESCE(sum(e.cost_usd), 0)::numeric AS cost,
            pl.ia_budget_usd AS presupuesto
       FROM tenants t
       LEFT JOIN plan_limits pl ON pl.plan = t.plan
       LEFT JOIN agent_executions e
         ON e.tenant_id = t.id AND e.created_at >= $1
      GROUP BY t.id, t.name, t.plan, pl.ia_budget_usd
     HAVING COALESCE(sum(e.cost_usd), 0) > 0
      ORDER BY 4 DESC
      LIMIT 100`,
    [desde],
  );
  return r.rows.map((row) => {
    const costUsd = Number(row.cost);
    const presupuesto = row.presupuesto === null ? null : Number(row.presupuesto);
    const pct = presupuesto && presupuesto > 0 ? Math.round((costUsd / presupuesto) * 100) : null;
    return {
      tenantId: row.id as string,
      nombre: row.name as string,
      plan: row.plan as string,
      costUsdCiclo: costUsd,
      costClpCiclo: Math.round(costUsd * usdClp),
      presupuestoUsd: presupuesto,
      pct,
      nivel: pct === null ? 'ok' : pct >= 100 ? 'excedido' : pct >= umbral ? 'atencion' : 'ok',
    };
  });
}
