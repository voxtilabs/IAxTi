import type { Pool, PoolClient } from 'pg';
import { publishEvent, type Consumer, type EventEnvelope } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import { isWithinWindow, salePorProveedor } from '@iaxti/module-conversations';
import { writeAudit } from '@iaxti/module-audit';
import { ruleModuleGaps, ACTION_REQUIREMENTS, type Action } from '../domain/rules';
import { executeAction, loadObject, type EngineDeps } from './engine';

// Secuencias (#63, SPEC §15): "día 1 mensaje, día 3 si no respondió,
// día 7 tarea" — y se CORTAN solas cuando el cliente responde o la
// oportunidad se mueve. El seguimiento como proceso, no como recuerdo.

export interface SequenceStep {
  /** Horas de espera DESDE el paso anterior (0 = al tiro). */
  afterHours: number;
  /** Solo corre si el cliente NO ha respondido desde la inscripción. */
  onlyIfNoReply?: boolean;
  action: Action;
}

export interface Sequence {
  id: string;
  name: string;
  steps: SequenceStep[];
  active: boolean;
  createdAt: Date;
}

function rowToSequence(row: Record<string, unknown>): Sequence {
  return {
    id: row.id as string,
    name: row.name as string,
    steps: row.steps as SequenceStep[],
    active: row.active as boolean,
    createdAt: row.created_at as Date,
  };
}

export interface Enrollment {
  id: string;
  sequenceId: string;
  sequenceName?: string;
  conversationId: string;
  contactId: string;
  dealId: string | null;
  currentStep: number;
  totalSteps?: number;
  status: 'running' | 'completed' | 'stopped';
  stopReason: string | null;
  nextRunAt: Date | null;
}

function rowToEnrollment(row: Record<string, unknown>): Enrollment {
  return {
    id: row.id as string,
    sequenceId: row.sequence_id as string,
    sequenceName: (row.sequence_name as string) ?? undefined,
    conversationId: row.conversation_id as string,
    contactId: row.contact_id as string,
    dealId: (row.deal_id as string) ?? null,
    currentStep: Number(row.current_step),
    totalSteps: row.total_steps === undefined ? undefined : Number(row.total_steps),
    status: row.status as Enrollment['status'],
    stopReason: (row.stop_reason as string) ?? null,
    nextRunAt: (row.next_run_at as Date) ?? null,
  };
}

export function validateSteps(steps: SequenceStep[]): void {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('La secuencia necesita al menos un paso.');
  }
  for (const paso of steps) {
    if (!(Number(paso.afterHours) >= 0)) {
      throw new Error('Cada paso necesita sus horas de espera (0 o más).');
    }
    if (!paso.action || !ACTION_REQUIREMENTS[paso.action.kind]) {
      throw new Error(`Acción desconocida en un paso: ${paso.action?.kind}.`);
    }
    if (paso.action.kind === 'send_message' && !String(paso.action.params?.body ?? '').trim()) {
      throw new Error('El mensaje de un paso no puede ir vacío.');
    }
  }
}

export async function createSequence(
  client: PoolClient,
  input: { tenantId: string; name: string; steps: SequenceStep[]; actor: string; requestId?: string },
): Promise<Sequence> {
  if (!input.name?.trim()) throw new Error('La secuencia necesita un nombre.');
  validateSteps(input.steps);
  const r = await client.query(
    `INSERT INTO sequences (tenant_id, name, steps) VALUES ($1, $2, $3) RETURNING *`,
    [input.tenantId, input.name.trim(), JSON.stringify(input.steps)],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'automations.sequence.create',
    resource: 'sequence',
    resourceId: r.rows[0].id,
    result: 'ok',
    metadata: { name: input.name.trim(), steps: input.steps.length },
    requestId: input.requestId,
  });
  return rowToSequence(r.rows[0]);
}

export async function listSequences(client: PoolClient, tenantId: string): Promise<Sequence[]> {
  const r = await client.query('SELECT * FROM sequences WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
  return r.rows.map(rowToSequence);
}

/**
 * Inscribe una conversación (con su contacto y, si hay, su oportunidad).
 * Doble inscripción viva = error claro; una cortada se puede re-inscribir.
 */
export async function enroll(
  client: PoolClient,
  input: {
    tenantId: string;
    sequenceId: string;
    conversationId: string;
    dealId?: string;
    actor: string;
    requestId?: string;
  },
): Promise<Enrollment> {
  const seq = await client.query('SELECT * FROM sequences WHERE tenant_id = $1 AND id = $2', [
    input.tenantId,
    input.sequenceId,
  ]);
  if (seq.rowCount === 0) throw new Error('No encontramos esa secuencia.');
  const sequence = rowToSequence(seq.rows[0]);
  if (!sequence.active) throw new Error('Esa secuencia está apagada.');
  const conv = await loadObject(client, input.tenantId, 'conversation', input.conversationId);
  if (!conv) throw new Error('No encontramos esa conversación.');

  const viva = await client.query(
    `SELECT 1 FROM sequence_enrollments
      WHERE tenant_id = $1 AND sequence_id = $2 AND conversation_id = $3 AND status = 'running'`,
    [input.tenantId, input.sequenceId, input.conversationId],
  );
  if ((viva.rowCount ?? 0) > 0) throw new Error('Esta conversación ya está en esa secuencia.');
  await client.query(
    `DELETE FROM sequence_enrollments
      WHERE tenant_id = $1 AND sequence_id = $2 AND conversation_id = $3 AND status <> 'running'`,
    [input.tenantId, input.sequenceId, input.conversationId],
  );

  const r = await client.query(
    `INSERT INTO sequence_enrollments
       (tenant_id, sequence_id, conversation_id, contact_id, deal_id, enrolled_by, next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(hours => $7)) RETURNING *`,
    [
      input.tenantId,
      input.sequenceId,
      input.conversationId,
      conv.contactId,
      input.dealId ?? null,
      input.actor,
      sequence.steps[0].afterHours,
    ],
  );
  await publishEvent(client, {
    name: 'sequence.started',
    tenantId: input.tenantId,
    payload: { enrollmentId: r.rows[0].id, sequenceId: input.sequenceId, conversationId: input.conversationId },
    actor: input.actor,
    requestId: input.requestId,
  });
  return rowToEnrollment(r.rows[0]);
}

async function stopEnrollments(
  client: PoolClient,
  tenantId: string,
  where: { conversationId?: string; dealId?: string },
  reason: string,
): Promise<number> {
  const r = await client.query(
    `UPDATE sequence_enrollments SET status = 'stopped', stop_reason = $2, updated_at = now()
      WHERE tenant_id = $1 AND status = 'running'
        AND ($3::uuid IS NULL OR conversation_id = $3)
        AND ($4::uuid IS NULL OR deal_id = $4)
      RETURNING id, sequence_id, conversation_id`,
    [tenantId, reason, where.conversationId ?? null, where.dealId ?? null],
  );
  for (const fila of r.rows) {
    await publishEvent(client, {
      name: 'sequence.stopped',
      tenantId,
      payload: { enrollmentId: fila.id, sequenceId: fila.sequence_id, conversationId: fila.conversation_id, reason },
      actor: 'system',
    });
  }
  return r.rowCount ?? 0;
}

/** El corte automático (SPEC §15): responde el cliente o se mueve el deal. */
export function sequenceConsumers(): Consumer[] {
  const onMessage = async (event: EventEnvelope, client: PoolClient) => {
    const p = event.payload as Record<string, unknown>;
    await stopEnrollments(
      client,
      event.tenantId,
      { conversationId: p.conversationId as string },
      'el cliente respondió',
    );
  };
  const onStage = async (event: EventEnvelope, client: PoolClient) => {
    const p = event.payload as Record<string, unknown>;
    await stopEnrollments(
      client,
      event.tenantId,
      { dealId: p.dealId as string },
      'la oportunidad cambió de etapa',
    );
  };
  return [
    { name: 'automations.seq.message_received', moduleId: 'automations', event: 'message.received', handler: onMessage },
    { name: 'automations.seq.stage_changed', moduleId: 'automations', event: 'deal.stage_changed', handler: onStage },
  ];
}

/**
 * El tick de secuencias (cola scheduled): ejecuta los pasos vencidos con
 * las MISMAS leyes del motor — consentimiento, silencio (cola outbound)
 * y ventana de 24 h (fuera de ventana el mensaje se salta con aviso
 * hasta que las plantillas de #44 existan).
 */
export async function sweepSequences(pool: Pool, deps: EngineDeps): Promise<number> {
  const tenants = await pool.query(
    `SELECT DISTINCT tenant_id FROM sequence_enrollments
      WHERE status = 'running' AND next_run_at <= now()`,
  );
  let corridos = 0;
  for (const { tenant_id: tenantId } of tenants.rows) {
    corridos += await withTenant(pool, tenantId, async (client) => {
      const vencidos = await client.query(
        `SELECT e.*, s.steps, s.name AS sequence_name, s.active AS sequence_active
           FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id
          WHERE e.tenant_id = $1 AND e.status = 'running' AND e.next_run_at <= now()
          ORDER BY e.next_run_at LIMIT 100`,
        [tenantId],
      );
      let n = 0;
      for (const fila of vencidos.rows) {
        const steps = fila.steps as SequenceStep[];
        const paso = steps[fila.current_step];
        if (!paso || fila.sequence_active === false) {
          await client.query(
            `UPDATE sequence_enrollments SET status = 'stopped', stop_reason = 'la secuencia se apagó', updated_at = now()
              WHERE id = $1`,
            [fila.id],
          );
          continue;
        }
        // Doble red del corte: ¿respondió el cliente desde la inscripción?
        if (paso.onlyIfNoReply) {
          const respondio = await client.query(
            `SELECT 1 FROM messages
              WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'in'
                AND created_at > $3 LIMIT 1`,
            [tenantId, fila.conversation_id, fila.created_at],
          );
          if ((respondio.rowCount ?? 0) > 0) {
            await stopEnrollments(client, tenantId, { conversationId: fila.conversation_id }, 'el cliente respondió');
            continue;
          }
        }
        const faltan = ruleModuleGaps([paso.action], deps.activeModules);
        let detalle: string;
        if (faltan.length > 0) {
          // Módulo apagado: la secuencia se DETIENE guardando el porqué.
          await client.query(
            `UPDATE sequence_enrollments SET status = 'stopped', stop_reason = $2, updated_at = now() WHERE id = $1`,
            [fila.id, `necesita el módulo ${faltan.join(', ')} y está apagado`],
          );
          continue;
        }
        const objeto = await loadObject(client, tenantId, 'conversation', fila.conversation_id);
        if (!objeto) continue;
        try {
          if (paso.action.kind === 'send_message' && salePorProveedor(objeto.channel as string)) {
            const conv = await client.query(
              'SELECT last_inbound_at FROM conversations WHERE tenant_id = $1 AND id = $2',
              [tenantId, fila.conversation_id],
            );
            // La ventana es POR CANAL: Instagram y Messenger tienen la suya,
            // y aplicarles la de WhatsApp era casualidad, no criterio. El
            // canal sale del objeto, que ya lo trae cargado.
            if (!isWithinWindow(objeto.channel as string, conv.rows[0]?.last_inbound_at ?? null)) {
              // Fuera de ventana solo salen plantillas (#44).
              detalle = 'fuera de la ventana de mensajería: el paso queda para la plantilla (#44)';
              await avanzar(client, fila, steps, detalle);
              n += 1;
              continue;
            }
          }
          detalle = await executeAction(
            client,
            { tenantId, action: paso.action, objectKind: 'conversation', objeto },
            deps,
          );
        } catch (err) {
          detalle =
            (err as Error).message === 'SIN_CONSENTIMIENTO'
              ? 'sin consentimiento: el paso de mensaje se saltó'
              : `el paso falló: ${(err as Error).message}`;
        }
        await avanzar(client, fila, steps, detalle);
        n += 1;
      }
      return n;
    });
  }
  return corridos;

  async function avanzar(
    client: PoolClient,
    fila: Record<string, unknown>,
    steps: SequenceStep[],
    detalle: string,
  ): Promise<void> {
    const siguiente = Number(fila.current_step) + 1;
    if (siguiente >= steps.length) {
      await client.query(
        `UPDATE sequence_enrollments SET status = 'completed', current_step = $2, stop_reason = $3, updated_at = now()
          WHERE id = $1`,
        [fila.id, siguiente, detalle],
      );
      await publishEvent(client, {
        name: 'sequence.completed',
        tenantId: fila.tenant_id as string,
        payload: { enrollmentId: fila.id, sequenceId: fila.sequence_id, detail: detalle },
        actor: 'system',
      });
      return;
    }
    await client.query(
      `UPDATE sequence_enrollments
          SET current_step = $2, stop_reason = $3,
              next_run_at = now() + make_interval(hours => $4), updated_at = now()
        WHERE id = $1`,
      [fila.id, siguiente, detalle, steps[siguiente].afterHours],
    );
  }
}

/** El estado para la ficha del contacto (SPEC §15). */
export async function enrollmentsForContact(
  client: PoolClient,
  tenantId: string,
  contactId: string,
): Promise<Enrollment[]> {
  const r = await client.query(
    `SELECT e.*, s.name AS sequence_name, jsonb_array_length(s.steps) AS total_steps
       FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id
      WHERE e.tenant_id = $1 AND e.contact_id = $2
      ORDER BY e.created_at DESC LIMIT 10`,
    [tenantId, contactId],
  );
  return r.rows.map(rowToEnrollment);
}

export async function stopEnrollment(
  client: PoolClient,
  input: { tenantId: string; enrollmentId: string; actor: string },
): Promise<void> {
  const r = await client.query(
    `UPDATE sequence_enrollments SET status = 'stopped', stop_reason = 'detenida a mano', updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
    [input.tenantId, input.enrollmentId],
  );
  if (r.rowCount === 0) throw new Error('Esa inscripción ya no está corriendo.');
}
