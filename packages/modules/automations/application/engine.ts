import type { Pool, PoolClient } from 'pg';
import { diaEn, publishEvent, type Consumer, type EventEnvelope } from '@iaxti/core';
import { zonaDelTenant } from '@iaxti/module-organizations';
import { idsDeTenants, withTenant } from '@iaxti/db';
import {
  addInternalNote,
  assignConversation,
  sendMessage,
  updateDeliveryStatus,
} from '@iaxti/module-conversations';
import { canReceiveBusinessInitiated, createActivity, moveDealStage } from '@iaxti/module-crm';
import { isWithinWindow, salePorProveedor } from '@iaxti/module-conversations';
import type { ActivityType } from '@iaxti/module-crm';
import { evaluateConditions, ruleModuleGaps, type Action } from '../domain/rules';
import { rowToRule, type Rule } from './rules';

// El motor (#62, SPEC §15): corre cuando el vendedor no está mirando —
// pero con las MISMAS reglas del humano: consentimiento siempre, silencio
// del tenant (la cola outbound lo aplica), y si algo falla tres veces
// sobre el mismo objeto, se detiene ahí y avisa.

/** Autor sentinel para notas/acciones del motor (no hay humano detrás). */
export const AUTOMATION_AUTHOR = '00000000-0000-0000-0000-000000000000';

const MAX_FAILURES_PER_OBJECT = 3;

export interface EngineDeps {
  /** Módulos activos (capabilities): decide qué acciones existen. */
  activeModules: string[];
  /** Encola el saliente de WhatsApp (la cola outbound respeta silencio, #43). */
  enqueueOutbound?: (job: { tenantId: string; messageId: string; requestId?: string }) => Promise<void>;
}

export interface RunResult {
  status: 'ok' | 'failed' | 'skipped';
  detail: string | null;
}

export async function loadObject(
  client: PoolClient,
  tenantId: string,
  kind: 'conversation' | 'deal',
  id: string,
): Promise<Record<string, unknown> | null> {
  if (kind === 'conversation') {
    const r = await client.query(
      `SELECT c.id, c.contact_id, c.channel, c.state, c.owner_id, c.last_inbound_at
         FROM conversations c WHERE c.tenant_id = $1 AND c.id = $2`,
      [tenantId, id],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return {
      id: row.id,
      contactId: row.contact_id,
      channel: row.channel,
      state: row.state,
      ownerId: row.owner_id,
    };
  }
  const r = await client.query(
    `SELECT d.id, d.contact_id, d.title, d.value_clp, d.owner_id, d.status, d.pipeline_id,
            s.name AS stage
       FROM deals d JOIN stages s ON s.id = d.stage_id
      WHERE d.tenant_id = $1 AND d.id = $2`,
    [tenantId, id],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return {
    id: row.id,
    contactId: row.contact_id,
    title: row.title,
    valueClp: row.value_clp === null ? null : Number(row.value_clp),
    ownerId: row.owner_id,
    status: row.status,
    stage: row.stage,
    pipelineId: row.pipeline_id,
  };
}

export async function executeAction(
  client: PoolClient,
  input: {
    tenantId: string;
    action: Action;
    objectKind: 'conversation' | 'deal';
    objeto: Record<string, unknown>;
    requestId?: string;
  },
  deps: EngineDeps,
): Promise<string> {
  const { action, objeto, tenantId } = input;
  const conversationId = input.objectKind === 'conversation' ? (objeto.id as string) : null;
  switch (action.kind) {
    case 'add_note': {
      if (!conversationId) throw new Error('add_note necesita una conversación.');
      await addInternalNote(client, {
        tenantId,
        conversationId,
        authorId: AUTOMATION_AUTHOR,
        body: String(action.params.body ?? ''),
      });
      return 'nota agregada';
    }
    case 'assign': {
      if (!conversationId) throw new Error('assign necesita una conversación.');
      await assignConversation(client, {
        tenantId,
        conversationId,
        toOwnerId: String(action.params.toOwnerId),
        reason: 'automatización',
        actor: 'automation',
        requestId: input.requestId,
      });
      return 'asignada';
    }
    case 'create_activity': {
      const contactId = objeto.contactId as string;
      const dueHours = Number(action.params.dueHours);
      await createActivity(client, {
        tenantId,
        contactId,
        dealId: input.objectKind === 'deal' ? (objeto.id as string) : undefined,
        type: (action.params.type as ActivityType) ?? 'tarea',
        title: String(action.params.title ?? 'Seguimiento'),
        ownerId: (objeto.ownerId as string) ?? undefined,
        dueAt: Number.isFinite(dueHours) ? new Date(Date.now() + dueHours * 3600_000) : undefined,
      });
      return 'tarea creada';
    }
    case 'move_stage': {
      if (input.objectKind !== 'deal') throw new Error('move_stage necesita una oportunidad.');
      const etapa = await client.query(
        `SELECT id FROM stages WHERE tenant_id = $1 AND pipeline_id = $2 AND lower(name) = lower($3)`,
        [tenantId, objeto.pipelineId, String(action.params.stageName ?? '')],
      );
      if (etapa.rowCount === 0) throw new Error(`No existe la etapa "${action.params.stageName}".`);
      await moveDealStage(client, {
        tenantId,
        dealId: objeto.id as string,
        stageId: etapa.rows[0].id,
        requestId: input.requestId,
      });
      return `movida a ${action.params.stageName}`;
    }
    case 'send_message': {
      if (!conversationId) throw new Error('send_message necesita una conversación.');
      // Consentimiento SIEMPRE (SPEC §8): sin opt-in no sale nada.
      const puede = await canReceiveBusinessInitiated(client, tenantId, objeto.contactId as string);
      if (!puede) throw new Error('SIN_CONSENTIMIENTO');
      // La ventana de mensajería, ANTES de escribir nada (SPEC §11): fuera
      // de ella el proveedor rechaza el envío, el mensaje queda `failed` en
      // la bandeja y, a los tres fallos, la regla se detiene sola para ese
      // objeto. Saltarse el paso con su motivo es mucho más honesto — es lo
      // que ya hacían las secuencias.
      if (salePorProveedor(objeto.channel as string)) {
        const ultimo = await client.query(
          'SELECT last_inbound_at FROM conversations WHERE tenant_id = $1 AND id = $2',
          [tenantId, conversationId],
        );
        if (!isWithinWindow(objeto.channel as string, ultimo.rows[0]?.last_inbound_at ?? null)) {
          throw new Error('FUERA_DE_VENTANA');
        }
      }
      const message = await sendMessage(client, {
        tenantId,
        conversationId,
        authorKind: 'system',
        type: 'texto',
        body: String(action.params.body ?? ''),
        requestId: input.requestId,
      });
      if (salePorProveedor(objeto.channel as string)) {
        if (!deps.enqueueOutbound) throw new Error('La cola de salida no está disponible.');
        // La cola outbound aplica el silencio del tenant (#43): un envío
        // iniciado por el negocio en horario de silencio SE DIFIERE allá.
        await deps.enqueueOutbound({ tenantId, messageId: message.id, requestId: input.requestId });
        return 'mensaje en cola (respeta silencio y consentimiento)';
      }
      // Solo el webchat y el simulador llegan acá: se entregan en la app.
      await updateDeliveryStatus(client, {
        tenantId,
        messageId: message.id,
        status: 'sent',
        requestId: input.requestId,
      });
      return 'mensaje enviado';
    }
    default:
      throw new Error(`Acción desconocida: ${(action as Action).kind}.`);
  }
}

/**
 * Corre UNA regla sobre UN objeto, con idempotencia por dedupe_key.
 * Devuelve null si no aplicaba (condiciones, dedupe o regla detenida
 * silenciosa); el run queda registrado en rule_runs cuando hay algo
 * que contar.
 */
export async function runRule(
  client: PoolClient,
  input: {
    tenantId: string;
    rule: Rule;
    objectKind: 'conversation' | 'deal';
    objectId: string;
    dedupeKey: string;
    requestId?: string;
  },
  deps: EngineDeps,
): Promise<RunResult | null> {
  const { tenantId, rule } = input;
  const ya = await client.query('SELECT 1 FROM rule_runs WHERE dedupe_key = $1', [input.dedupeKey]);
  if ((ya.rowCount ?? 0) > 0) return null; // ya corrió por esto

  const registrar = async (status: RunResult['status'], detail: string | null): Promise<RunResult> => {
    await client.query(
      `INSERT INTO rule_runs (tenant_id, rule_id, object_kind, object_id, dedupe_key, status, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING`,
      [tenantId, rule.id, input.objectKind, input.objectId, input.dedupeKey, status, detail],
    );
    return { status, detail };
  };

  // Tres fallos sobre el MISMO objeto: la regla se detiene para él (§15).
  const fallos = await client.query(
    `SELECT count(*)::int AS n FROM rule_runs
      WHERE tenant_id = $1 AND rule_id = $2 AND object_id = $3 AND status = 'failed'`,
    [tenantId, rule.id, input.objectId],
  );
  if (fallos.rows[0].n >= MAX_FAILURES_PER_OBJECT) {
    return registrar('skipped', 'detenida para este objeto tras 3 fallos');
  }

  // Módulo apagado: la regla SE PAUSA con aviso — no falla en silencio.
  const faltan = ruleModuleGaps(rule.actions, deps.activeModules);
  if (faltan.length > 0) {
    const motivo = `Necesita el módulo ${faltan.join(', ')} y está apagado.`;
    await client.query(
      `UPDATE rules SET active = false, pause_reason = $3, updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, rule.id, motivo],
    );
    await publishEvent(client, {
      name: 'automation.paused',
      tenantId,
      payload: { ruleId: rule.id, reason: motivo },
      actor: 'system',
      requestId: input.requestId,
    });
    return registrar('skipped', motivo);
  }

  const objeto = await loadObject(client, tenantId, input.objectKind, input.objectId);
  if (!objeto) return null;
  if (!evaluateConditions(objeto, rule.conditions)) return null;

  try {
    const detalles: string[] = [];
    for (const action of rule.actions) {
      detalles.push(await executeAction(client, { tenantId, action, objectKind: input.objectKind, objeto, requestId: input.requestId }, deps));
    }
    const res = await registrar('ok', detalles.join('; '));
    await publishEvent(client, {
      name: 'automation.ran',
      tenantId,
      payload: { ruleId: rule.id, objectKind: input.objectKind, objectId: input.objectId, detail: res.detail },
      actor: 'system',
      requestId: input.requestId,
    });
    return res;
  } catch (err) {
    const mensaje = (err as Error).message;
    if (mensaje === 'FUERA_DE_VENTANA') {
      // Tampoco es un fallo de la regla: es la ventana de mensajería (§11).
      // Contarlo como fallo detendría la regla a los tres intentos.
      return registrar('skipped', 'fuera de la ventana de mensajería: queda para una plantilla (#44)');
    }
    if (mensaje === 'SIN_CONSENTIMIENTO') {
      // No es un fallo de la regla: es la ley del consentimiento (§8).
      return registrar('skipped', 'el contacto no tiene consentimiento para iniciados del negocio');
    }
    const res = await registrar('failed', mensaje);
    const total = fallos.rows[0].n + 1;
    await publishEvent(client, {
      name: 'automation.failed',
      tenantId,
      payload: {
        ruleId: rule.id,
        objectKind: input.objectKind,
        objectId: input.objectId,
        error: mensaje,
        stoppedForObject: total >= MAX_FAILURES_PER_OBJECT,
      },
      actor: 'system',
      requestId: input.requestId,
    });
    return res;
  }
}

const EVENT_OBJECT: Record<string, { kind: 'conversation' | 'deal'; key: string }> = {
  'conversation.created': { kind: 'conversation', key: 'conversationId' },
  'conversation.state_changed': { kind: 'conversation', key: 'conversationId' },
  'conversation.assigned': { kind: 'conversation', key: 'conversationId' },
  'agent.escalated': { kind: 'conversation', key: 'conversationId' },
  'deal.created': { kind: 'deal', key: 'dealId' },
  'deal.stage_changed': { kind: 'deal', key: 'dealId' },
};

/** El handler de eventos: reglas activas del tenant con ese disparador. */
export async function handleAutomationEvent(
  event: EventEnvelope,
  client: PoolClient,
  deps: EngineDeps,
): Promise<void> {
  const mapping = EVENT_OBJECT[event.name];
  if (!mapping) return;
  const objectId = (event.payload as Record<string, unknown>)[mapping.key] as string | undefined;
  if (!objectId) return;
  const reglas = await client.query(
    `SELECT * FROM rules WHERE tenant_id = $1 AND active AND trigger->>'kind' = 'event'
        AND trigger->>'event' = $2`,
    [event.tenantId, event.name],
  );
  for (const fila of reglas.rows) {
    await runRule(
      client,
      {
        tenantId: event.tenantId,
        rule: rowToRule(fila),
        objectKind: mapping.kind,
        objectId,
        dedupeKey: `${fila.id}:${objectId}:ev${event.id}`,
        requestId: event.requestId ?? undefined,
      },
      deps,
    );
  }
}

/** Los consumidores para el OutboxDispatcher (main de workers). */
export function automationConsumers(deps: EngineDeps): Consumer[] {
  return Object.keys(EVENT_OBJECT).map((event) => ({
    name: `automations.${event}`,
    moduleId: 'automations',
    event,
    handler: (e, client) => handleAutomationEvent(e, client, deps),
  }));
}

/**
 * El barrido de tiempo (cola scheduled): "2 días en etapa", "sin
 * respuesta hace 24 h". Dedupe por día — no muele al mismo objeto en
 * cada pasada.
 */
export async function sweepTimeRules(pool: Pool, deps: EngineDeps): Promise<number> {
  // De `tenants`, no de `rules` (#286): una consulta suelta a una tabla con
  // RLS devuelve cero filas con el rol de producción.
  const tenants = { rows: (await idsDeTenants(pool)).map((id) => ({ tenant_id: id })) };
  let corridas = 0;
  // El día del NEGOCIO: con el día en UTC, el dedupe cambiaba a las 21:00
  // en Chile y una regla "una vez al día" podía dispararle DOS veces al
  // mismo cliente en la misma tarde. Y es el día de CADA negocio: uno en
  // otra zona cierra su día a otra hora.
  for (const { tenant_id: tenantId } of tenants.rows) {
    corridas += await withTenant(pool, tenantId, async (client) => {
      const dia = diaEn(await zonaDelTenant(client, tenantId));
      const reglas = await client.query(
        `SELECT * FROM rules WHERE tenant_id = $1 AND active AND trigger->>'kind' = 'time'`,
        [tenantId],
      );
      let n = 0;
      for (const fila of reglas.rows) {
        const rule = rowToRule(fila);
        if (rule.trigger.kind !== 'time') continue;
        const t = rule.trigger.time;
        const candidatos =
          t.base === 'no_reply'
            ? await client.query(
                `SELECT c.id FROM conversations c
                  WHERE c.tenant_id = $1 AND c.state IN ('new','open')
                    AND c.last_inbound_at < now() - make_interval(hours => $2)
                    AND NOT EXISTS (
                      SELECT 1 FROM messages m
                       WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id
                         AND m.direction = 'out' AND m.created_at > c.last_inbound_at)
                  LIMIT 200`,
                [tenantId, t.hours],
              )
            : await client.query(
                `SELECT d.id FROM deals d JOIN stages s ON s.id = d.stage_id
                  WHERE d.tenant_id = $1 AND d.status = 'open'
                    AND d.stage_entered_at < now() - make_interval(hours => $2)
                    AND ($3::text IS NULL OR lower(s.name) = lower($3))
                  LIMIT 200`,
                [tenantId, t.hours, t.stageName ?? null],
              );
        for (const c of candidatos.rows) {
          const res = await runRule(
            client,
            {
              tenantId,
              rule,
              objectKind: t.base === 'no_reply' ? 'conversation' : 'deal',
              objectId: c.id,
              dedupeKey: `${rule.id}:${c.id}:${dia}`,
            },
            deps,
          );
          if (res) n += 1;
        }
      }
      return n;
    });
  }
  return corridas;
}

export async function listRuns(
  client: PoolClient,
  tenantId: string,
  ruleId?: string,
): Promise<Array<{ id: string; ruleId: string; objectKind: string; objectId: string; status: string; detail: string | null; createdAt: Date }>> {
  const r = await client.query(
    `SELECT * FROM rule_runs WHERE tenant_id = $1 AND ($2::uuid IS NULL OR rule_id = $2)
      ORDER BY created_at DESC LIMIT 50`,
    [tenantId, ruleId ?? null],
  );
  return r.rows.map((row) => ({
    id: row.id,
    ruleId: row.rule_id,
    objectKind: row.object_kind,
    objectId: row.object_id,
    status: row.status,
    detail: row.detail ?? null,
    createdAt: row.created_at,
  }));
}
