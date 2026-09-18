import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { getContext, updateSummary, updateTranscription } from '@iaxti/module-conversations';
import { FORMATO_SUGERENCIA, parseSuggestion } from '../domain/parser';
import { runAgentTask } from './runtime';
import type { HerramientaExpuesta, ModelPortFactory, TranscribePort } from './models';
import { aiSdkModelPort, aiSdkTranscriber } from './models';
import { listAgents, type Agent } from './agents';

// El copiloto en assist (#48): sugiere, resume, clasifica y califica —
// el humano manda con un toque. NUNCA crea nada solo en assist.

export interface Suggestion {
  id: string;
  conversationId: string;
  messageId: string | null;
  text: string;
  confidence: number | null;
  intent: string | null;
  leadScore: 'frio' | 'tibio' | 'caliente' | null;
  suggestDeal: boolean;
  status: 'pending' | 'sent' | 'dismissed' | 'expired';
  expiresAt: Date;
  feedback: 'up' | 'down' | null;
  createdAt: Date;
}

function rowToSuggestion(row: Record<string, unknown>): Suggestion {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    messageId: (row.message_id as string) ?? null,
    text: row.text as string,
    confidence: row.confidence === null ? null : Number(row.confidence),
    intent: (row.intent as string) ?? null,
    leadScore: (row.lead_score as Suggestion['leadScore']) ?? null,
    suggestDeal: row.suggest_deal as boolean,
    status: row.status as Suggestion['status'],
    expiresAt: row.expires_at as Date,
    feedback: (row.feedback as Suggestion['feedback']) ?? null,
    createdAt: row.created_at as Date,
  };
}

/** El agente activo del tenant en modo assist o autónomo (no off). */
export async function activeAgent(client: PoolClient, tenantId: string): Promise<Agent | null> {
  const agentes = await listAgents(client, tenantId);
  return agentes.find((a) => a.active && a.defaultMode !== 'off') ?? null;
}

/**
 * El contexto con el resumen rodante al día — palanca de costo nº 1 (§40):
 * si quedó cola sin resumir, se comprime ANTES de generar; el hilo completo
 * jamás viaja al modelo. Lo comparten sugerir (#48) y responder (#49).
 */
export async function refreshedContext(
  client: PoolClient,
  input: { tenantId: string; conversationId: string; requestId?: string },
  agent: Agent,
  modelPortFactory: ModelPortFactory,
): Promise<Awaited<ReturnType<typeof getContext>>> {
  let ctx = await getContext(client, input.tenantId, input.conversationId);
  if (ctx.unsummarized > 0) {
    const minSeq = ctx.lastMessages[0]?.seq ?? 0;
    const viejos = await client.query(
      `SELECT direction, body FROM messages
        WHERE tenant_id = $1 AND conversation_id = $2
          AND seq < $3 AND seq > COALESCE($4, 0)
        ORDER BY seq`,
      [input.tenantId, input.conversationId, minSeq, ctx.summarySeq],
    );
    const texto = viejos.rows
      .map((m) => `${m.direction === 'in' ? 'Cliente' : 'Negocio'}: ${m.body ?? '[adjunto]'}`)
      .join('\n');
    const resumen = await runAgentTask(
      client,
      {
        tenantId: input.tenantId,
        agent,
        task: 'resumir',
        prompt: `Resume en 3 frases lo esencial de esta parte de la conversación (acuerdos, datos del cliente, pendientes):\n${ctx.summary ? `Resumen previo: ${ctx.summary}\n` : ''}${texto}`,
        requestId: input.requestId,
      },
      modelPortFactory,
    );
    if (resumen.status === 'ok' && resumen.text) {
      await updateSummary(client, {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        summary: resumen.text.trim(),
        seq: minSeq - 1,
      });
      ctx = { ...ctx, summary: resumen.text.trim() };
    }
  }
  return ctx;
}

/**
 * La corrida del copiloto por mensaje entrante: contexto con N pequeño +
 * resumen rodante (refrescado aquí mismo cuando hay cola vieja), UNA
 * generación que devuelve sugerencia + intención + calificación +
 * "¿creo la oportunidad?" — y jamás actúa sola en assist.
 */
export async function suggestForInbound(
  client: PoolClient,
  input: {
    tenantId: string;
    conversationId: string;
    messageId?: string;
    /** Bloque de conocimiento del negocio con citas (#51), si el módulo está activo. */
    knowledge?: string | null;
    requestId?: string;
    /**
     * Las herramientas de lectura que el modelo puede pedir (#240). Las arma
     * el worker con `herramientasExpuestas`, que ya lleva adentro el permiso
     * de la persona y el rastro. Si no vienen, el copiloto sugiere con lo
     * que tiene, como hasta ahora.
     */
    tools?: HerramientaExpuesta[];
  },
  modelPortFactory: ModelPortFactory = aiSdkModelPort,
): Promise<Suggestion | null> {
  const agent = await activeAgent(client, input.tenantId);
  if (!agent) return null;

  const ctx = await refreshedContext(client, input, agent, modelPortFactory);

  const contexto = [
    `Cliente: ${ctx.contact.name ?? 'sin nombre'}${ctx.contact.phone ? ` (${ctx.contact.phone})` : ''}.`,
    ctx.summary ? `Resumen de lo anterior: ${ctx.summary}` : null,
    input.knowledge ?? null,
    'Últimos mensajes:',
    ...ctx.lastMessages.map((m) => `${m.direction === 'in' ? 'Cliente' : 'Negocio'}: ${m.body ?? '[adjunto]'}`),
  ]
    .filter(Boolean)
    .join('\n');

  const res = await runAgentTask(
    client,
    {
      tenantId: input.tenantId,
      agent,
      task: 'sugerir',
      context: contexto,
      prompt: FORMATO_SUGERENCIA,
      requestId: input.requestId,
      ...(input.tools?.length ? { tools: input.tools } : {}),
    },
    modelPortFactory,
  );
  if (res.status === 'failed' || !res.text) return null;
  // La respuesta vino cortada por el tope de salida: no hay sugerencia que
  // mostrar. Mejor que la bandeja no ofrezca nada a que ofrezca media frase
  // —o JSON crudo— para mandarle a un cliente.
  if (res.truncada) {
    console.warn(
      `[${input.requestId ?? 'sin-request'}] sugerencia descartada: el modelo ` +
        'se quedó sin espacio de salida. Subir maxOutputTokens o acortar el contexto.',
    );
    return null;
  }

  const payload = parseSuggestion(res.text);
  if (!payload.sugerencia.trim()) return null;
  const fila = await client.query(
    `INSERT INTO suggestions
       (tenant_id, agent_id, conversation_id, message_id, execution_id, text,
        confidence, intent, lead_score, suggest_deal)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      input.tenantId,
      agent.id,
      input.conversationId,
      input.messageId ?? null,
      res.executionId,
      payload.sugerencia,
      payload.confianza,
      payload.intencion,
      payload.calificacion,
      payload.crearOportunidad,
    ],
  );
  await publishEvent(client, {
    name: 'agent.suggested',
    tenantId: input.tenantId,
    payload: {
      suggestionId: fila.rows[0].id,
      conversationId: input.conversationId,
      confidence: payload.confianza,
      suggestDeal: payload.crearOportunidad,
    },
    actor: 'system',
    requestId: input.requestId,
  });
  return rowToSuggestion(fila.rows[0]);
}

/** La sugerencia vigente de la conversación (pendiente y sin expirar). */
export async function pendingSuggestion(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
): Promise<Suggestion | null> {
  await client.query(
    `UPDATE suggestions SET status = 'expired', updated_at = now()
      WHERE tenant_id = $1 AND conversation_id = $2 AND status = 'pending' AND expires_at < now()`,
    [tenantId, conversationId],
  );
  const r = await client.query(
    `SELECT * FROM suggestions
      WHERE tenant_id = $1 AND conversation_id = $2 AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, conversationId],
  );
  return r.rowCount === 0 ? null : rowToSuggestion(r.rows[0]);
}

export async function resolveSuggestion(
  client: PoolClient,
  input: { tenantId: string; suggestionId: string; status: 'sent' | 'dismissed' },
): Promise<Suggestion> {
  const r = await client.query(
    `UPDATE suggestions SET status = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'pending' RETURNING *`,
    [input.tenantId, input.suggestionId, input.status],
  );
  if (r.rowCount === 0) throw new Error('Esa sugerencia ya no está vigente.');
  return rowToSuggestion(r.rows[0]);
}

/** 👍/👎 con motivo opcional: el dataset de evaluación (#53) come de aquí. */
export async function feedbackSuggestion(
  client: PoolClient,
  input: { tenantId: string; suggestionId: string; feedback: 'up' | 'down'; reason?: string },
): Promise<void> {
  const r = await client.query(
    `UPDATE suggestions SET feedback = $3, feedback_reason = $4, updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.suggestionId, input.feedback, input.reason ?? null],
  );
  if (r.rowCount === 0) throw new Error('No encontramos esa sugerencia.');
}

/** El análisis para la ficha (#48): última lectura de la IA + acciones. */
export async function conversationAnalysis(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
): Promise<{
  summary: string | null;
  intent: string | null;
  leadScore: string | null;
  suggestDeal: boolean;
  acciones: Array<{ at: Date; que: string; estado: string; feedback: string | null }>;
}> {
  const conv = await client.query(
    'SELECT summary FROM conversations WHERE tenant_id = $1 AND id = $2',
    [tenantId, conversationId],
  );
  const ultimas = await client.query(
    `SELECT text, intent, lead_score, suggest_deal, status, feedback, created_at
       FROM suggestions WHERE tenant_id = $1 AND conversation_id = $2
      ORDER BY created_at DESC LIMIT 10`,
    [tenantId, conversationId],
  );
  const ultima = ultimas.rows[0];
  return {
    summary: conv.rows[0]?.summary ?? null,
    intent: ultima?.intent ?? null,
    leadScore: ultima?.lead_score ?? null,
    suggestDeal: ultima?.suggest_deal ?? false,
    acciones: ultimas.rows.map((s) => ({
      at: s.created_at,
      que: `Sugirió: "${String(s.text).slice(0, 80)}"`,
      estado: s.status,
      feedback: s.feedback ?? null,
    })),
  };
}

/**
 * Transcribe un audio entrante (#48): la transcripción queda como texto
 * BUSCABLE en el mensaje y entra sola al contexto del copiloto. Registra
 * su Execution (task transcribir) para cuota y costo.
 */
export async function transcribeInboundAudio(
  client: PoolClient,
  input: {
    tenantId: string;
    messageId: string;
    bytes: Uint8Array;
    contentType: string;
    requestId?: string;
  },
  transcriber: TranscribePort = aiSdkTranscriber(),
): Promise<string | null> {
  const inicio = Date.now();
  try {
    const texto = await transcriber.transcribe({ bytes: input.bytes, contentType: input.contentType });
    if (!texto) return null;
    await updateTranscription(client, {
      tenantId: input.tenantId,
      messageId: input.messageId,
      transcription: texto,
    });
    await client.query(
      `INSERT INTO agent_executions
         (tenant_id, task, provider, model, input, output, latency_ms, trace_id, explanation)
       VALUES ($1,'transcribir','google','gemini-flash-latest',$2,$3,$4,$5,$6)`,
      [
        input.tenantId,
        JSON.stringify({ messageId: input.messageId, contentType: input.contentType }),
        JSON.stringify({ chars: texto.length }),
        Date.now() - inicio,
        input.requestId ?? null,
        'Transcribió un audio entrante; el texto quedó buscable en el mensaje.',
      ],
    );
    return texto;
  } catch {
    return null; // un audio sin transcribir no frena nada
  }
}
