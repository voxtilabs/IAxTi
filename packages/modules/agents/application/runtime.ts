import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ModuleRegistry } from '@iaxti/core';
import { publishEvent } from '@iaxti/core';
import { getTenantSettings } from '@iaxti/module-organizations';
import { incrementUsage } from '@iaxti/module-organizations';
import {
  DEFAULT_TASK_OUTPUT_TOKENS,
  estimateCostUsd,
  iaSettings,
  redactPII,
  vaRedactadoAlProveedor,
} from '../domain/config';
import type { AgentTask, Provider } from '../domain/config';
import { componerPrompt, resolverObjetivo } from '../domain/objetivo';
import { aiSdkModelPort, type HerramientaExpuesta, type ModelPortFactory } from './models';
import { getVersionedPrompt, traceGeneration } from './langfuse';
import { afterExecutionQuota, getQuota } from './quota';
import type { Agent } from './agents';

// El runtime (#47, SPEC §13): una corrida = una Execution completa —
// entrada, decisión, tokens, costo, latencia, trace y explicación legible.

export interface RunInput {
  tenantId: string;
  agent: Agent;
  task: AgentTask;
  prompt: string;
  /** Contexto que se antepone al prompt (ficha, mensajes, etc.). */
  context?: string;
  /** El MISMO trace desde el request hasta la generación (SPEC §13). */
  requestId?: string;
  actorUserId?: string;
  /**
   * Las herramientas que el modelo puede pedir durante esta tarea (#240).
   * Se arman con `herramientasExpuestas`, que ya dejó adentro la
   * verificación de permisos y el rastro. Sin ellas, una sola llamada como
   * siempre.
   */
  tools?: HerramientaExpuesta[];
  /** Tope de salida. Sin esto, el de la tarea (`DEFAULT_TASK_OUTPUT_TOKENS`). */
  maxOutputTokens?: number;
  /**
   * Los módulos activos del tenant. Sin esto el objetivo no se puede
   * resolver: se asume que NO hay ninguno, o sea que el agente avisa que no
   * puede cumplirlo en vez de prometer. Fallar hacia no prometer es lo
   * correcto — la regla dice que la IA nunca compromete lo que una tool no
   * confirmó.
   */
  activeModules?: readonly string[];
}

export interface RunResult {
  /** El fallo SE DEVUELVE, no se lanza: la Execution fallida y su evento
   *  viven en la misma transacción, y un throw los revertiría. */
  status: 'ok' | 'failed';
  /** true si corrió con el modelo económico por cuota al 100 % (#52). */
  degraded?: boolean;
  executionId: string;
  text: string | null;
  error: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  latencyMs: number;
  traceId: string;
  provider: Provider;
  model: string;
  /** Qué herramientas pidió el modelo. Vacío si no pidió ninguna. */
  herramientasUsadas?: string[];
  /** La respuesta vino cortada por el tope de salida: no se puede usar. */
  truncada?: boolean;
}

/**
 * Las tools permitidas de un agente: la intersección entre lo configurado
 * y lo que los MÓDULOS ACTIVOS declaran (SPEC §13) — un módulo apagado se
 * lleva sus tools consigo.
 *
 * La EJECUCIÓN vive en `herramientas.ts` (issue 240) y hoy alcanza a las de
 * solo lectura, con la identidad y los permisos de la PERSONA que la
 * disparó. `herramientas-expuestas.ts` es lo que se le OFRECE al modelo, y
 * el copiloto se las pasa a `runAgentTask` en `tools`. Las que escriben
 * están declaradas y ni siquiera se ofrecen: hasta dónde actúa la IA sola
 * es una decisión pendiente.
 *
 * (El comentario anterior decía que esto llegaba con el copiloto, #48. Ese
 * issue se cerró hace rato y las herramientas seguían sin ejecutarse: un
 * puntero vencido hace creer que algo ya se resolvió.)
 */
export function allowedToolsFor(agent: Agent, registry: ModuleRegistry): string[] {
  const activas = new Set<string>();
  const modulos: string[] = [];
  for (const salud of registry.health()) {
    if (!salud.active) continue;
    modulos.push(salud.id);
    for (const tool of registry.manifest(salud.id).tools ?? []) activas.add(tool);
  }
  // Las del OBJETIVO se suman a las que el dueño configuró (#315).
  //
  // Antes `allowedTools` era una lista libre que había que curar a mano, y un
  // agente que tenía que agendar sin la tool de agenda prometía horas que no
  // podía tomar. El objetivo sabe qué necesita; el dueño ya no tiene que
  // saberlo. Sigue mandando el registry: una tool de un módulo apagado no se
  // ofrece, venga de donde venga.
  const delObjetivo = agent.objetivo
    ? resolverObjetivo(agent.objetivo, agent.objetivoDetalle, modulos).tools
    : [];
  const todas = new Set([...agent.allowedTools, ...delObjetivo]);
  return [...todas].filter((t) => activas.has(t));
}

export async function runAgentTask(
  client: PoolClient,
  input: RunInput,
  modelPortFactory: ModelPortFactory = aiSdkModelPort,
): Promise<RunResult> {
  const settings = iaSettings(await getTenantSettings(client, input.tenantId));
  // Por tarea manda la configuración del tenant; el agente es el fallback.
  const porTarea = settings.tasks[input.task];
  let provider = (porTarea?.provider ?? input.agent.provider) as Provider;
  let model = porTarea?.model ?? input.agent.model;
  const traceId = input.requestId ?? randomUUID();

  // La cuota (#52): al 100 %, assist sigue con el modelo económico si el
  // tenant lo configuró; sin él, se corta con explicación — y sin gastar.
  const quota = await getQuota(client, input.tenantId);
  let degraded = false;
  if (quota.exhausted) {
    if (settings.economico) {
      provider = settings.economico.provider;
      model = settings.economico.model;
      degraded = true;
    } else {
      const rechazo =
        'La cuota de IA del mes está completa. Sube de plan o configura un modelo económico para seguir.';
      const fila = await client.query(
        `INSERT INTO agent_executions
           (tenant_id, agent_id, task, provider, model, input, latency_ms, trace_id, status, error, explanation)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,'failed',$8,$9) RETURNING id`,
        [
          input.tenantId,
          input.agent.id,
          input.task,
          provider,
          model,
          JSON.stringify({ prompt: input.prompt }),
          traceId,
          rechazo,
          `Tarea "${input.task}" rechazada por cuota (${quota.used}/${quota.limit}).`,
        ],
      );
      return {
        status: 'failed',
        executionId: fila.rows[0].id,
        text: null,
        error: rechazo,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: null,
        latencyMs: 0,
        traceId,
        provider,
        model,
      };
    }
  }

  // Prompt versionado en Langfuse; sin Langfuse, el fallback CONFIGURADO.
  const base =
    (input.agent.promptName
      ? await getVersionedPrompt(input.agent.promptName, input.agent.promptVersion ?? undefined)
      : null) ??
    input.agent.fallbackSystemPrompt ??
    `Eres ${input.agent.name}, el asistente de este negocio. Responde en ${input.agent.language}, breve y útil.${input.agent.personality ? ` Personalidad: ${input.agent.personality}` : ''}`;
  // El OBJETIVO va adelante (#315): qué tiene que lograr manda sobre cómo lo
  // dice. Y si el módulo que lo hace posible está apagado, la advertencia va
  // antes que todo — es lo único que evita que prometa una hora que nadie
  // puede dar. Sin objetivo, el prompt queda exactamente como antes.
  const resuelto =
    input.agent.objetivo !== null && input.agent.objetivo !== undefined
      ? resolverObjetivo(input.agent.objetivo, input.agent.objetivoDetalle, input.activeModules ?? [])
      : null;
  const system = componerPrompt(base, resuelto) ?? base;

  const promptCompleto = input.context ? `${input.context}\n\n${input.prompt}` : input.prompt;
  /**
   * Lo que sale HACIA EL PROVEEDOR, que no es lo mismo que lo que se
   * guarda (ADR-0023).
   *
   * `redactPII` existía y protegía a Langfuse y al dataset de evaluación:
   * el texto que viaja al modelo iba entero, y tiene que ir entero —
   * redactar lo que se le pide interpretar rompe la sugerencia.
   *
   * Con una excepción, y por eso esto existe: `clasificar` no interpreta,
   * etiqueta. Saber si un mensaje es una consulta de precio o un reclamo no
   * necesita el teléfono ni el nombre de quien escribe. Es la única tarea
   * de alto volumen que sobrevive a la redacción, y por eso es la única
   * donde se puede probar un proveedor cuyos términos de datos no dicen
   * qué hacen con lo que reciben.
   */
  const haciaElProveedor = vaRedactadoAlProveedor(provider, input.task)
    ? redactPII(promptCompleto)
    : promptCompleto;
  const inicio = Date.now();
  try {
    const res = await modelPortFactory(provider, model).generate({
      system,
      prompt: haciaElProveedor,
      // El tope lo manda la TAREA, no un default único del puerto: lo que
      // necesita `configurar` y lo que necesita `resumir` no se parecen.
      maxOutputTokens: input.maxOutputTokens ?? DEFAULT_TASK_OUTPUT_TOKENS[input.task],
      ...(input.tools?.length ? { tools: input.tools } : {}),
    });
    const latencyMs = Date.now() - inicio;
    const costUsd = estimateCostUsd(provider, model, res.tokensIn, res.tokensOut);

    const fila = await client.query(
      `INSERT INTO agent_executions
         (tenant_id, agent_id, task, provider, model, input, output,
          tokens_in, tokens_out, cost_usd, latency_ms, trace_id, explanation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        input.tenantId,
        input.agent.id,
        input.task,
        provider,
        model,
        JSON.stringify({ prompt: input.prompt }),
        JSON.stringify({
          text: res.text,
          // Qué herramientas se usaron queda en la ejecución: sin esto,
          // una respuesta con precio real y una inventada se ven igual.
          ...(res.herramientasUsadas?.length ? { herramientas: res.herramientasUsadas } : {}),
          // Que la respuesta viniera cortada también (#436): el copiloto la
          // descarta —media frase no se le muestra a nadie— y desde la
          // bandeja eso se veía igual que "el modelo no entendió", que es
          // otro problema con otro remedio.
          ...(res.truncada ? { truncada: true } : {}),
        }),
        res.tokensIn,
        res.tokensOut,
        costUsd,
        latencyMs,
        traceId,
        `Tarea "${input.task}" con ${provider}/${model} en ${latencyMs} ms.` +
          (degraded ? ' (cuota al 100 %: modelo económico)' : '') +
          (res.herramientasUsadas?.length
            ? ` Consultó: ${res.herramientasUsadas.join(', ')}.`
            : ''),
      ],
    );
    // El medidor de §6 y los umbrales de la cuota (#52).
    await incrementUsage(client, input.tenantId, 'ia_executions');
    await afterExecutionQuota(client, input.tenantId, traceId);
    await publishEvent(client, {
      name: 'agent.executed',
      tenantId: input.tenantId,
      payload: { executionId: fila.rows[0].id, task: input.task, provider, model, costUsd },
      actor: input.actorUserId ?? 'system',
      requestId: traceId,
    });
    // A Langfuse va REDACTADO según la política del tenant (SPEC §13).
    traceGeneration({
      traceId,
      tenantId: input.tenantId,
      task: input.task,
      provider,
      model,
      input: settings.redactPII ? redactPII(promptCompleto) : promptCompleto,
      output: settings.redactPII ? redactPII(res.text) : res.text,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      latencyMs,
    });
    return {
      status: 'ok',
      ...(res.truncada ? { truncada: true } : {}),
      ...(res.herramientasUsadas?.length ? { herramientasUsadas: res.herramientasUsadas } : {}),
      degraded,
      executionId: fila.rows[0].id,
      text: res.text,
      error: null,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      costUsd,
      latencyMs,
      traceId,
      provider,
      model,
    };
  } catch (err) {
    const latencyMs = Date.now() - inicio;
    const fila = await client.query(
      `INSERT INTO agent_executions
         (tenant_id, agent_id, task, provider, model, input, latency_ms, trace_id, status, error, explanation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'failed',$9,$10) RETURNING id`,
      [
        input.tenantId,
        input.agent.id,
        input.task,
        provider,
        model,
        JSON.stringify({ prompt: input.prompt }),
        latencyMs,
        traceId,
        (err as Error).message,
        `La tarea "${input.task}" falló con ${provider}/${model}.`,
      ],
    );
    await publishEvent(client, {
      name: 'agent.failed',
      tenantId: input.tenantId,
      payload: { task: input.task, provider, model, error: (err as Error).message },
      actor: 'system',
      requestId: traceId,
    });
    return {
      status: 'failed',
      executionId: fila.rows[0].id,
      text: null,
      error: (err as Error).message,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      latencyMs,
      traceId,
      provider,
      model,
    };
  }
}

export async function listExecutions(
  client: PoolClient,
  tenantId: string,
  limit = 25,
): Promise<
  Array<{
    id: string;
    task: string;
    provider: string;
    model: string;
    tokensIn: number | null;
    tokensOut: number | null;
    costUsd: number | null;
    latencyMs: number | null;
    traceId: string | null;
    explanation: string | null;
    status: string;
    createdAt: Date;
  }>
> {
  const r = await client.query(
    `SELECT id, task, provider, model, tokens_in, tokens_out, cost_usd,
            latency_ms, trace_id, explanation, status, created_at
       FROM agent_executions WHERE tenant_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [tenantId, Math.min(limit, 100)],
  );
  return r.rows.map((row) => ({
    id: row.id,
    task: row.task,
    provider: row.provider,
    model: row.model,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    latencyMs: row.latency_ms,
    traceId: row.trace_id,
    explanation: row.explanation,
    status: row.status,
    createdAt: row.created_at,
  }));
}
