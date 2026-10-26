import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { requestHandoff } from '@iaxti/module-conversations';
import { writeAudit } from '@iaxti/module-audit';
import {
  detectEscalation,
  esEcoDelContexto,
  formatoAutonomo,
  parseAutonomous,
  type EscalationReason,
} from '../domain/escalation';
import { runAgentTask } from './runtime';
import type { ModelPortFactory } from './models';
import { aiSdkModelPort } from './models';
import { isAutonomousPaused } from './quota';
import { activeAgent, refreshedContext } from './copilot';
import { accionQueSePuedeProponer, accionesParaElPrompt } from './acciones-en-la-conversacion';
import { fechaDeHoy } from '../domain/contexto';
import type { Agent } from './agents';
import { abrirIntento } from './objetivo-medido';
import { quienesSon, quienFue, type Quien } from '@iaxti/module-identity';

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
  escalationNotice: string | null;
} {
  const l = agent.limits as Record<string, unknown>;
  const conf = Number(l.confidence_threshold);
  const turnos = Number(l.max_agent_turns);
  const monto = Number(l.money_limit_clp);
  const aviso = typeof l.escalation_notice === 'string' ? l.escalation_notice.trim() : '';
  return {
    confidenceThreshold: Number.isFinite(conf) && conf > 0 && conf <= 1 ? conf : 0.7,
    maxAgentTurns: Number.isFinite(turnos) && turnos > 0 ? turnos : 5,
    moneyLimitClp: Number.isFinite(monto) && monto > 0 ? monto : null,
    handoffUserId: typeof l.handoff_user_id === 'string' ? l.handoff_user_id : null,
    escalationNotice: aviso !== '' ? aviso : null,
  };
}

/**
 * Lo que el CLIENTE recibe cuando la IA escala (#1019).
 *
 * `escalate()` avisaba al equipo y pedía el handoff, pero al cliente no le
 * decía ni una palabra: en el widget eso se ve como un chat roto, y en
 * WhatsApp como un negocio que ignora. El texto no promete plazo ni inventa
 * nada — «te va a responder una persona» es lo único que acá se sabe seguro.
 * La firma no ofrece «escribe humano»: el humano ya viene en camino.
 */
export function avisoDeEscalada(agent: Agent): string {
  const texto =
    guardrailLimits(agent).escalationNotice ??
    'Gracias por escribirnos. Te va a responder una persona del equipo.';
  return `${texto}\n\n${agent.name} — asistente virtual.`;
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

/**
 * Quién puso esta conversación en autónomo, y cuándo (#697).
 *
 * `agent_conversation_modes.set_by` se escribía en cada cambio y la bandeja
 * mostraba solo el modo. Dejar que la IA conteste sola a un cliente es la
 * decisión más delicada del producto: quien abre la conversación después tiene
 * que poder ver quién la tomó, en la misma pantalla donde está el interruptor.
 *
 * Separado de `conversationMode` a propósito: eso lo llama el motor en cada
 * mensaje y no necesita resolver nombres. Esto lo llama la pantalla.
 */
export interface ModoDeLaConversacion {
  mode: ConversationMode;
  puestoPor: Quien | null;
  puestoEl: Date;
}

export async function modoConQuienLoPuso(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
): Promise<ModoDeLaConversacion | null> {
  const r = await client.query(
    `SELECT mode, set_by, updated_at FROM agent_conversation_modes
      WHERE tenant_id = $1 AND conversation_id = $2`,
    [tenantId, conversationId],
  );
  if (r.rowCount === 0) return null;
  const f = r.rows[0];
  return {
    mode: f.mode as ConversationMode,
    puestoPor: quienFue(await quienesSon(client, tenantId, [f.set_by as string | null]), f.set_by),
    puestoEl: f.updated_at as Date,
  };
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

/**
 * ¿Esta conversación la está atendiendo la IA en autónomo, AHORA? (#830)
 *
 * Existe para el barrido de desatendidas: una conversación `new` sin dueño
 * que la IA está contestando cumplía las dos condiciones del aviso
 * `conversation.unattended`, y el supervisor recibía una alarma por algo que
 * sí se estaba atendiendo — un aviso que se repite sin motivo enseña a
 * ignorar los avisos. Sin agente activo, o fuera de horario, o pausado por
 * cuota: false, y el aviso sale como siempre.
 */
export async function laIaLaEstaAtendiendo(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const agent = await activeAgent(client, tenantId);
  if (!agent) return false;
  return (await effectiveMode(client, agent, tenantId, conversationId, now)) === 'autonomous';
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
  | { action: 'escalated'; reason: string; aviso: string }
  | { action: 'reply'; text: string; agentName: string; executionId: string };

/**
 * La corrida autónoma por entrante (#49). Devuelve la respuesta para que
 * el WORKER la entregue por el canal — este módulo no conoce colas. Los
 * detectores deterministas corren ANTES de gastar un token.
 */
export async function autoRespondForInbound(
  client: PoolClient,
  input: {
    tenantId: string;
    conversationId: string;
    knowledge?: string | null;
    /**
     * Las fuentes detrás de ese conocimiento (#714). Acá importan MÁS que en la
     * sugerencia: en modo autónomo nadie revisa antes de que salga, así que la
     * única forma de reconstruir después de dónde salió lo que se le dijo al
     * cliente es que la corrida lo tenga escrito.
     */
    fuentes?: Array<{ id: string; nombre: string }>;
    requestId?: string;
    /** Módulos activos: contra ellos se resuelve el objetivo del agente (#315). */
    activeModules?: readonly string[];
  },
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
    return { action: 'escalated', reason: String(reason), aviso: avisoDeEscalada(agent) };
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
  // Sin conocimiento (#51 apagado o vacío), el prompt ya obliga a escalar
  // ante precio/stock/plazo que no estén en el contexto: escala MÁS.
  const contexto = [
    // Sin saber qué día es, «el próximo jueves a las 4» no tiene traducción
    // a ISO y toda acción con fecha nace muerta (#1049). Zona del defecto
    // del producto (America/Santiago, SPEC: pymes chilenas).
    `Hoy es ${fechaDeHoy(now)}.`,
    `Cliente: ${ctx.contact.name ?? 'sin nombre'}${ctx.contact.phone ? ` (${ctx.contact.phone})` : ''}.`,
    ctx.summary ? `Resumen de lo anterior: ${ctx.summary}` : null,
    input.knowledge ?? null,
    'Últimos mensajes:',
    ...ctx.lastMessages.map((m) => `${m.direction === 'in' ? 'Cliente' : 'Negocio'}: ${m.body ?? '[adjunto]'}`),
  ]
    .filter(Boolean)
    .join('\n');

  if (agent.objetivo) {
    await abrirIntento(client, {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      contactId: ctx.contact.id,
      agentId: agent.id,
      objetivo: agent.objetivo,
      objetivoDetalle: agent.objetivoDetalle,
    });
  }

  const res = await runAgentTask(
    client,
    {
      tenantId: input.tenantId,
      agent,
      task: 'responder',
      context: contexto,
      // Por dónde la purga alcanza esta corrida (#1079): el contexto que se
      // guarda lleva los últimos mensajes y el nombre del cliente, así que la
      // fila tiene que morir cuando muere la conversación.
      conversationId: input.conversationId,
      ...(input.activeModules ? { activeModules: input.activeModules } : {}),
      // Con el catálogo de lo proponible (#1030): además de responder puede
      // dejar una acción esperando el visto bueno, igual que en assist.
      prompt: formatoAutonomo({
        moneyLimitClp: limits.moneyLimitClp,
        acciones: accionesParaElPrompt(input.activeModules),
      }),
      requestId: input.requestId,
      ...(input.fuentes ? { fuentes: input.fuentes } : {}),
    },
    modelPortFactory,
  );
  // Un fallo del modelo deja al cliente esperando: eso también escala.
  if (res.status === 'failed' || !res.text) return escalar('error_del_modelo');
  // Cortado por el tope de salida: el parser ya escalaba (un JSON sin
  // cerrar no parsea), pero lo reportaba como 'error_del_modelo'. El
  // modelo no falló — no le alcanzó el espacio, y eso se arregla distinto.
  // Con el motivo verdadero el dueño puede ver que le pasa siempre en las
  // conversaciones largas, en vez de creer que el proveedor anda mal.
  if (res.truncada) return escalar('respuesta_cortada');

  const payload = parseAutonomous(res.text);
  // La acción que dejó propuesta, escale o responda (#1030). Sin texto: si
  // respondió, la respuesta ya salió; si escaló, el que viene es el humano —
  // y en ambos casos lo único pendiente es la acción, validada igual que en
  // assist (#1000).
  const guardarAccion = async (): Promise<void> => {
    const accion = accionQueSePuedeProponer(payload.accion);
    if (!accion) return;
    const fila = await client.query(
      `INSERT INTO suggestions
         (tenant_id, agent_id, conversation_id, execution_id, text,
          confidence, intent, lead_score, suggest_deal, accion)
       VALUES ($1,$2,$3,$4,'',$5,$6,$7,false,$8) RETURNING id`,
      [
        input.tenantId,
        agent.id,
        input.conversationId,
        res.executionId,
        payload.confianza,
        payload.intencion,
        payload.calificacion,
        JSON.stringify(accion),
      ],
    );
    await publishEvent(client, {
      name: 'agent.suggested',
      tenantId: input.tenantId,
      payload: {
        suggestionId: fila.rows[0].id,
        conversationId: input.conversationId,
        confidence: payload.confianza,
        suggestDeal: false,
      },
      actor: 'system',
      requestId: input.requestId,
    });
  };
  if (payload.escalar) {
    await guardarAccion();
    return escalar(payload.motivoEscalar ?? 'otro');
  }
  // El volcado del conocimiento no viaja al cliente (#1021): el prompt ya lo
  // prohíbe, pero es estocástico y esto es determinista. Con #1019, escalar
  // significa que el cliente recibe el aviso — nunca el bloque pegado.
  if (esEcoDelContexto(payload.respuesta, input.knowledge)) return escalar('eco_del_contexto');
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

  await guardarAccion();

  return {
    action: 'reply',
    text: payload.respuesta,
    agentName: agent.name,
    executionId: res.executionId,
  };
}
