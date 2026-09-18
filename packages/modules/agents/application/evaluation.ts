import type { PoolClient } from 'pg';
import { getTenantSettings } from '@iaxti/module-organizations';
import { iaSettings, redactPII, type Provider } from '../domain/config';
import { formatoJuez, parseJudge, type EvalCase, type JudgeScores } from '../domain/judge';
import { FORMATO_SUGERENCIA, parseSuggestion } from '../domain/parser';
import type { ModelPortFactory } from './models';
import { aiSdkModelPort } from './models';
import type { Agent } from './agents';
import { traceGeneration } from './langfuse';

// Evaluación (#53): cambiar prompt, modelo o proveedor sin evaluar es
// cambiar el producto a ciegas. El juez puntúa contra criterios; el gate
// compara con la versión anterior — ninguna versión empeora.

/**
 * El feedback humano de la bandeja alimenta el dataset (SPEC §13): cada
 * pulgar se vuelve un caso ANONIMIZADO (una sola vez por sugerencia).
 * 👍 = referencia de calidad; 👎 + motivo = error que no debe repetirse.
 */
export async function harvestFeedbackCases(
  client: PoolClient,
  tenantId: string,
): Promise<number> {
  const pendientes = await client.query(
    `SELECT s.id, s.agent_id, s.text, s.feedback, s.feedback_reason, s.conversation_id,
            c.summary
       FROM suggestions s
       LEFT JOIN conversations c ON c.id = s.conversation_id AND c.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1 AND s.feedback IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM eval_cases e WHERE e.suggestion_id = s.id)`,
    [tenantId],
  );
  let creados = 0;
  for (const fila of pendientes.rows) {
    const mensajes = await client.query(
      `SELECT direction, COALESCE(body, transcription) AS body FROM messages
        WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY seq DESC LIMIT 6`,
      [tenantId, fila.conversation_id],
    );
    const contexto = redactPII(
      [
        fila.summary ? `Resumen de lo anterior: ${fila.summary}` : null,
        'Últimos mensajes:',
        ...mensajes.rows
          .reverse()
          .map((m) => `${m.direction === 'in' ? 'Cliente' : 'Negocio'}: ${m.body ?? '[adjunto]'}`),
      ]
        .filter(Boolean)
        .join('\n'),
    );
    const criterios =
      fila.feedback === 'up'
        ? ['Responde al menos tan bien como la referencia que el equipo aprobó']
        : [
            `NO repetir el error que marcó el equipo${fila.feedback_reason ? `: ${fila.feedback_reason}` : ''}`,
            'Mantiene el tono cercano y no inventa datos',
          ];
    await client.query(
      `INSERT INTO eval_cases (tenant_id, agent_id, suggestion_id, task, contexto, criterios, referencia, feedback)
       VALUES ($1,$2,$3,'sugerir',$4,$5,$6,$7)
       ON CONFLICT (suggestion_id) DO NOTHING`,
      [
        tenantId,
        fila.agent_id,
        fila.id,
        contexto,
        JSON.stringify(criterios),
        redactPII(fila.text),
        fila.feedback,
      ],
    );
    creados += 1;
  }
  return creados;
}

export async function listEvalCases(client: PoolClient, tenantId: string): Promise<EvalCase[]> {
  const r = await client.query(
    `SELECT id, contexto, criterios FROM eval_cases WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  return r.rows.map((fila) => ({
    id: fila.id,
    contexto: fila.contexto,
    criterios: fila.criterios as string[],
  }));
}

/**
 * Cuánto espacio de salida se le da a cada llamada de la evaluación.
 *
 * Estaba en 512 para las dos, y 512 NO alcanza: los modelos que razonan
 * gastan tokens de salida pensando antes de escribir, y en la primera
 * corrida real una sugerencia de tres líneas consumió 665. El juez con 256
 * devolvía `{"correctness": 0.8` —cortado— y eso se contaba como un cero.
 *
 * El costo de quedarse corto acá no es una respuesta fea: es un número
 * inventado guardado en `eval_runs` que después decide si una versión pasa.
 */
const TOPE_CANDIDATO = 1500;
const TOPE_JUEZ = 1024;

export interface EvalRun {
  id: string;
  agentId: string;
  task: string;
  provider: Provider;
  model: string;
  promptVersion: string | null;
  caseCount: number;
  /** De `caseCount`, cuántos dieron una nota legible. El promedio sale solo de estos. */
  casesMedidos: number;
  scores: Array<JudgeScores & { caseId: string; respuesta: string }>;
  score: number;
  createdAt: Date;
}

function rowToRun(row: Record<string, unknown>): EvalRun {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    task: row.task as string,
    provider: row.provider as Provider,
    model: row.model as string,
    promptVersion: (row.prompt_version as string) ?? null,
    caseCount: Number(row.case_count),
    casesMedidos: Number(row.cases_medidos ?? row.case_count),
    scores: row.scores as EvalRun['scores'],
    score: Number(row.score),
    createdAt: row.created_at as Date,
  };
}

/**
 * Corre el dataset contra la CONFIG ACTUAL del agente y guarda el run.
 * El juez usa el modelo de la tarea `configurar` (gama alta): juzgar mal
 * sale más caro que juzgar caro. No pasa por runAgentTask a propósito —
 * evaluar no consume la cuota de asistencias del tenant (#52).
 */
export async function runEvaluation(
  client: PoolClient,
  input: {
    tenantId: string;
    agent: Agent;
    cases: EvalCase[];
    requestId?: string;
  },
  candidateFactory: ModelPortFactory = aiSdkModelPort,
  judgeFactory: ModelPortFactory = aiSdkModelPort,
): Promise<EvalRun> {
  if (input.cases.length === 0) throw new Error('No hay casos que evaluar todavía.');
  const settings = iaSettings(await getTenantSettings(client, input.tenantId));
  const juezModelo = settings.tasks.configurar;
  const candidato = candidateFactory(input.agent.provider, input.agent.model);
  const juez = judgeFactory(juezModelo.provider, juezModelo.model);

  const scores: EvalRun['scores'] = [];
  for (const caso of input.cases) {
    const gen = await candidato.generate({
      system: input.agent.fallbackSystemPrompt ?? undefined,
      prompt: `${caso.contexto}\n\n${FORMATO_SUGERENCIA}`,
      maxOutputTokens: TOPE_CANDIDATO,
    });
    // Si al candidato lo cortaron, su respuesta está a medias por falta de
    // espacio, no por ser mala. Juzgarla da un cero que no dice nada del
    // modelo — y encima se paga el juez para conseguirlo.
    if (gen.truncada) {
      scores.push({
        correctness: 0,
        tono: 0,
        tools: 0,
        total: 0,
        comentario: 'La respuesta se cortó por falta de espacio: no se pudo evaluar.',
        medible: false,
        caseId: caso.id,
        respuesta: '',
      });
      continue;
    }
    const respuesta = parseSuggestion(gen.text).sugerencia;
    const veredicto = await juez.generate({
      prompt: formatoJuez({ contexto: caso.contexto, criterios: caso.criterios, respuesta }),
      maxOutputTokens: TOPE_JUEZ,
    });
    const notas = veredicto.truncada
      ? {
          correctness: 0,
          tono: 0,
          tools: 0,
          total: 0,
          comentario: 'El juez se cortó por falta de espacio: no se pudo evaluar.',
          medible: false,
        }
      : parseJudge(veredicto.text);
    scores.push({ ...notas, caseId: caso.id, respuesta });
    // Resultados también en Langfuse (best-effort, env-gated).
    traceGeneration({
      traceId: input.requestId ?? `eval-${input.agent.id}`,
      tenantId: input.tenantId,
      task: `eval:${caso.id}`,
      model: input.agent.model,
      provider: input.agent.provider,
      input: caso.contexto,
      output: `${respuesta}\n→ juez ${notas.total}: ${notas.comentario ?? ''}`,
      tokensIn: gen.tokensIn + veredicto.tokensIn,
      tokensOut: gen.tokensOut + veredicto.tokensOut,
      latencyMs: 0,
    });
  }
  // El promedio sale SOLO de los casos con nota legible.
  //
  // Antes los no medibles entraban como 0 y hundían el score. Eso rompe el
  // gate en los dos sentidos y ninguno avisa: si el run de la config VIGENTE
  // se cortó, su score queda en el suelo y `candidata >= actual` se cumple
  // solo — el gate aprueba cualquier cosa, incluida una versión peor. Y si
  // el que se cortó es el del candidato, al dueño le sale en pantalla "esa
  // versión rinde peor (0 vs 0.85)", que es falso.
  const medidos = scores.filter((s) => s.medible);
  if (medidos.length === 0) {
    throw new Error(
      'No se pudo evaluar ninguno de los casos: el modelo cortó todas las respuestas. ' +
        'Un run sin notas legibles no es un score de 0 — es que no hay medición, y guardarlo ' +
        'como 0 haría que el gate deje pasar cualquier versión.',
    );
  }
  const promedio =
    Math.round((medidos.reduce((a, s) => a + s.total, 0) / medidos.length) * 1000) / 1000;
  const r = await client.query(
    `INSERT INTO eval_runs (tenant_id, agent_id, task, provider, model, prompt_version, case_count, cases_medidos, scores, score)
     VALUES ($1,$2,'sugerir',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      input.tenantId,
      input.agent.id,
      input.agent.provider,
      input.agent.model,
      input.agent.promptVersion,
      input.cases.length,
      medidos.length,
      JSON.stringify(scores),
      promedio,
    ],
  );
  return rowToRun(r.rows[0]);
}

export async function listEvalRuns(
  client: PoolClient,
  tenantId: string,
  agentId: string,
): Promise<EvalRun[]> {
  const r = await client.query(
    `SELECT * FROM eval_runs WHERE tenant_id = $1 AND agent_id = $2
      ORDER BY created_at DESC LIMIT 20`,
    [tenantId, agentId],
  );
  return r.rows.map(rowToRun);
}

/** El último score de una config concreta (provider+model+prompt). */
export async function latestScoreFor(
  client: PoolClient,
  tenantId: string,
  agentId: string,
  config: { provider: string; model: string; promptVersion?: string | null },
): Promise<number | null> {
  const r = await client.query(
    `SELECT score FROM eval_runs
      WHERE tenant_id = $1 AND agent_id = $2 AND provider = $3 AND model = $4
        AND prompt_version IS NOT DISTINCT FROM $5
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, agentId, config.provider, config.model, config.promptVersion ?? null],
  );
  return r.rowCount === 0 ? null : Number(r.rows[0].score);
}

/**
 * El GATE (#53): un agente no pasa a una config con score menor al de la
 * versión vigente. Solo bloquea cuando HAY evidencia de ambas (sin runs
 * no hay con qué comparar — se permite y se recomienda evaluar).
 */
export async function evalGate(
  client: PoolClient,
  tenantId: string,
  agent: Agent,
  nueva: { provider: string; model: string; promptVersion?: string | null },
): Promise<{ allowed: boolean; actual: number | null; candidata: number | null }> {
  const actual = await latestScoreFor(client, tenantId, agent.id, {
    provider: agent.provider,
    model: agent.model,
    promptVersion: agent.promptVersion,
  });
  const candidata = await latestScoreFor(client, tenantId, agent.id, nueva);
  const allowed = actual === null || candidata === null || candidata >= actual;
  return { allowed, actual, candidata };
}
