import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { requestHandoff } from '@iaxti/module-conversations';
import { writeAudit } from '@iaxti/module-audit';
import {
  detectEscalation,
  formatoAutonomo,
  parseAutonomous,
  type EscalationReason,
} from '../domain/escalation';
import { runAgentTask } from './runtime';
import type { ModelPortFactory } from './models';
import { aiSdkModelPort } from './models';
import { isAutonomousPaused } from './quota';
import { activeAgent, refreshedContext } from './copilot';
import type { Agent } from './agents';

// El modo autónomo (#49, SPEC §13): la IA responde SOLA únicamente cuando
// el dueño lo permitió — por horario del tenant o por marca manual en la
// conversación. JAMÁS por defecto. Y ante cualquier señal de las reglas de
// escalamiento, suelta el control y avisa.

export type ConversationMode = 'assist' | 'autonomous' | 'off';

/** Los guardrails configurables del tenant, con los defaults de la spec. */
export function guardrailLimits(agent: Agent): {
  confidenceThreshold: number;
  maxAgentTurns: number;
  moneyLimitClp: number | null;
  handoffUserId: string | null;
} {
  const l = agent.limits as Record<string, unknown>;
  const conf = Number(l.confidence_threshold);
  const turnos = Number(l.max_agent_turns);
  const monto = Number(l.money_limit_clp);
  return {
    confidenceThreshold: Number.isFinite(conf) && conf > 0 && conf <= 1 ? conf : 0.7,
    maxAgentTurns: Number.isFinite(turnos) && turnos > 0 ? turnos : 5,
    moneyLimitClp: Number.isFinite(monto) && monto > 0 ? monto : null,
    handoffUserId: typeof l.handoff_user_id === 'string' ? l.handoff_user_id : null,
  };
}

/** La marca manual por conversación (o null si nunca se tocó). */
export async function conversationMode(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
): Promise<ConversationMode | null> {
  const r = await client.query(
    'SELECT mode FROM agent_conversation_modes WHERE tenant_id = $1 AND conversation_id = $2',
    [tenantId, conversationId],
  );
  return (r.rows[0]?.mode as ConversationMode) ?? null;
}

export async function setConversationMode(
  client: PoolClient,
  input: {
    tenantId: string;
    conversationId: string;
    mode: ConversationMode;
    actor: string;
    requestId?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO agent_conversation_modes (tenant_id, conversation_id, mode, set_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, conversation_id)
     DO UPDATE SET mode = $3, set_by = $4, updated_at = now()`,
    [input.tenantId, input.conversationId, input.mode, input.actor],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: input.actor === 'system' ? 'system' : 'user',
    action: 'agents.conversation_mode.set',
    resource: 'conversation',
    resourceId: input.conversationId,
    result: 'ok',
    metadata: { mode: input.mode },
    requestId: input.requestId,
  });
}

/** ¿El reloj cae dentro del horario autónomo del tenant? Vacío = nunca. */
export function inAutonomousHours(hours: Record<string, unknown>, now: Date): boolean {
  const start = typeof hours.start === 'string' ? hours.start : null;
  const end = typeof hours.end === 'string' ? hours.end : null;
  if (!start || !end) return false; // sin horario configurado: JAMÁS solo
  const days = Array.isArray(hours.days) ? (hours.days as number[]) : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(now.getDay())) return false;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  // start > end cruza medianoche (p. ej. 19:00–09:00).
  return start <= end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end;
}

/**
 * El modo EFECTIVO de una conversación: marca manual > pausa por cuota >
 * horario del agente > assist. La cuota al 100 % (#52) pausa lo autónomo
 * en TODAS las conversaciones — vuelven a assist con el aviso ya emitido.
 */
export async function effectiveMode(
  client: PoolClient,
  agent: Agent,
  tenantId: string,
  conversationId: string,
  now: Date = new Date(),
): Promise<ConversationMode> {
  if (!agent.active || agent.defaultMode === 'off') return 'off';
  const manual = await conversationMode(client, tenantId, conversationId);
  if (manual === 'off') return 'off';
  const quiereAutonomo =
    manual === 'autonomous' ||
    (manual === null &&
      agent.defaultMode === 'autonomous' &&
      inAutonomousHours(agent.autonomousHours, now));
  if (!quiereAutonomo) return 'assist';
  return (await isAutonomousPaused(client, tenantId, agent.id)) ? 'assist' : 'autonomous';
}

/** Escala: la conversación vuelve a assist, se avisa y se asigna según la regla. */
export async function escalate(
  client: PoolClient,
  input: {
    tenantId: string;
    conversationId: string;
    agent: Agent;
    reason: EscalationReason | string;
    requestId?: string;
  },
): Promise<void> {
  await setConversationMode(client, {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    mode: 'assist',
    actor: 'system',
    requestId: input.requestId,
  });
  await publishEvent(client, {
    name: 'agent.escalated',
    tenantId: input.tenantId,
    payload: {
      conversationId: input.conversationId,
      agentId: input.agent.id,
      reason: input.reason,
    },
    actor: 'system',
    requestId: input.requestId,
  });
  await requestHandoff(client, {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    toOwnerId: guardrailLimits(input.agent).handoffUserId,
    reason: `La IA escaló: ${input.reason}`,
    actor: 'system',
    requestId: input.requestId,
  });
}

export type AutonomousOutcome =
  | { action: 'none' }
  | { action: 'assist' }
  | { action: 'escalated'; reason: string }
  | { action: 'reply'; text: string; agentName: string; executionId: string };

/**
 * La corrida autónoma por entrante (#49). Devuelve la respuesta para que
 * el WORKER la entregue por el canal — este módulo no conoce colas. Los
 * detectores deterministas corren ANTES de gastar un token.
 */
export async function autoRespondForInbound(
  client: PoolClient,
  input: { tenantId: string; conversationId: string; requestId?: string },
  modelPortFactory: ModelPortFactory = aiSdkModelPort,
  now: Date = new Date(),
): Promise<AutonomousOutcome> {
  const agent = await activeAgent(client, input.tenantId);
  if (!agent) return { action: 'none' };
  const mode = await effectiveMode(client, agent, input.tenantId, input.conversationId, now);
  if (mode === 'off') return { action: 'none' };
  if (mode === 'assist') return { action: 'assist' };

  const limits = guardrailLimits(agent);
  const escalar = async (reason: EscalationReason | string): Promise<AutonomousOutcome> => {
    await escalate(client, { ...input, agent, reason });
    return { action: 'escalated', reason: String(reason) };
  };

  // Detector determinista sobre el entrante: manda sobre el modelo y es gratis.
  const entrante = await client.query(
    `SELECT COALESCE(body, transcription) AS body FROM messages
      WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'in'
      ORDER BY seq DESC LIMIT 1`,
    [input.tenantId, input.conversationId],
  );
  const detectado = detectEscalation(entrante.rows[0]?.body);
  if (detectado) return escalar(detectado);

  // Más de N turnos sin avanzar: respuestas del asistente sin que un humano
  // del equipo haya intervenido desde entonces (SPEC §13, default 5).
  const turnos = await client.query(
    `SELECT count(*)::int AS n FROM messages
      WHERE tenant_id = $1 AND conversation_id = $2
        AND direction = 'out' AND author_kind = 'agent'
        AND seq > COALESCE((
          SELECT max(seq) FROM messages
           WHERE tenant_id = $1 AND conversation_id = $2
             AND direction = 'out' AND author_kind = 'user'), 0)`,
    [input.tenantId, input.conversationId],
  );
  if (turnos.rows[0].n >= limits.maxAgentTurns) return escalar('sin_avance');

  const ctx = await refreshedContext(client, input, agent, modelPortFactory);
  const contexto = [
    `Cliente: ${ctx.contact.name ?? 'sin nombre'}${ctx.contact.phone ? ` (${ctx.contact.phone})` : ''}.`,
    ctx.summary ? `Resumen de lo anterior: ${ctx.summary}` : null,
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
      task: 'responder',
      context: contexto,
      prompt: formatoAutonomo({ moneyLimitClp: limits.moneyLimitClp }),
      requestId: input.requestId,
    },
    modelPortFactory,
  );
  // Un fallo del modelo deja al cliente esperando: eso también escala.
  if (res.status === 'failed' || !res.text) return escalar('error_del_modelo');

  const payload = parseAutonomous(res.text);
  if (payload.escalar) return escalar(payload.motivoEscalar ?? 'otro');
  if (payload.confianza < limits.confidenceThreshold) return escalar('confianza_baja');

  await publishEvent(client, {
    name: 'agent.acted',
    tenantId: input.tenantId,
    payload: {
      conversationId: input.conversationId,
      agentId: agent.id,
      executionId: res.executionId,
      intent: payload.intencion,
    },
    actor: 'system',
    requestId: input.requestId,
  });
  return {
    action: 'reply',
    text: payload.respuesta,
    agentName: agent.name,
    executionId: res.executionId,
  };
}
