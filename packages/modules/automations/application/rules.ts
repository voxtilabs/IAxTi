import type { PoolClient } from 'pg';
import { writeAudit } from '@iaxti/module-audit';
import {
  RULE_TEMPLATES,
  ruleModuleGaps,
  validateRule,
  evaluateConditions,
  type Action,
  type Condition,
  type Trigger,
} from '../domain/rules';

// Las reglas (#62): nacen APAGADAS — primero la vista previa, después el
// interruptor. Activar exige que los módulos de sus acciones estén vivos.

export interface Rule {
  id: string;
  name: string;
  trigger: Trigger;
  conditions: Condition[];
  actions: Action[];
  active: boolean;
  pauseReason: string | null;
  createdAt: Date;
}

export function rowToRule(row: Record<string, unknown>): Rule {
  return {
    id: row.id as string,
    name: row.name as string,
    trigger: row.trigger as Trigger,
    conditions: (row.conditions as Condition[]) ?? [],
    actions: (row.actions as Action[]) ?? [],
    active: row.active as boolean,
    pauseReason: (row.pause_reason as string) ?? null,
    createdAt: row.created_at as Date,
  };
}

export async function createRule(
  client: PoolClient,
  input: {
    tenantId: string;
    name: string;
    trigger: Trigger;
    conditions?: Condition[];
    actions: Action[];
    actor: string;
    requestId?: string;
  },
): Promise<Rule> {
  if (!input.name?.trim()) throw new Error('La regla necesita un nombre.');
  validateRule({ trigger: input.trigger, conditions: input.conditions ?? [], actions: input.actions });
  const r = await client.query(
    `INSERT INTO rules (tenant_id, name, trigger, conditions, actions)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [
      input.tenantId,
      input.name.trim(),
      JSON.stringify(input.trigger),
      JSON.stringify(input.conditions ?? []),
      JSON.stringify(input.actions),
    ],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'automations.rule.create',
    resource: 'rule',
    resourceId: r.rows[0].id,
    result: 'ok',
    metadata: { name: input.name.trim() },
    requestId: input.requestId,
  });
  return rowToRule(r.rows[0]);
}

/** Crea las tres reglas iniciales del vertical (apagadas, listas para activar). */
export async function seedTemplates(
  client: PoolClient,
  input: { tenantId: string; vertical: string; actor: string; requestId?: string },
): Promise<Rule[]> {
  const plantillas = RULE_TEMPLATES[input.vertical] ?? RULE_TEMPLATES.otro;
  const creadas: Rule[] = [];
  for (const t of plantillas) {
    const existe = await client.query(
      'SELECT 1 FROM rules WHERE tenant_id = $1 AND name = $2',
      [input.tenantId, t.name],
    );
    if ((existe.rowCount ?? 0) > 0) continue; // re-ejecutable: no duplica
    creadas.push(
      await createRule(client, {
        tenantId: input.tenantId,
        name: t.name,
        trigger: t.shape.trigger,
        conditions: t.shape.conditions,
        actions: t.shape.actions,
        actor: input.actor,
        requestId: input.requestId,
      }),
    );
  }
  return creadas;
}

export async function listRules(client: PoolClient, tenantId: string): Promise<Rule[]> {
  const r = await client.query('SELECT * FROM rules WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
  return r.rows.map(rowToRule);
}

export async function getRule(client: PoolClient, tenantId: string, ruleId: string): Promise<Rule> {
  const r = await client.query('SELECT * FROM rules WHERE tenant_id = $1 AND id = $2', [tenantId, ruleId]);
  if (r.rowCount === 0) throw new Error('No encontramos esa regla.');
  return rowToRule(r.rows[0]);
}

/** Activar exige los módulos de sus acciones vivos; apagar siempre se puede. */
export async function setRuleActive(
  client: PoolClient,
  input: {
    tenantId: string;
    ruleId: string;
    active: boolean;
    activeModules: string[];
    actor: string;
    requestId?: string;
  },
): Promise<Rule> {
  const rule = await getRule(client, input.tenantId, input.ruleId);
  if (input.active) {
    const faltan = ruleModuleGaps(rule.actions, input.activeModules);
    if (faltan.length > 0) {
      throw new Error(`Para activar esta regla enciende primero: ${faltan.join(', ')}.`);
    }
  }
  const r = await client.query(
    `UPDATE rules SET active = $3, pause_reason = NULL, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.ruleId, input.active],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: input.active ? 'automations.rule.activate' : 'automations.rule.deactivate',
    resource: 'rule',
    resourceId: input.ruleId,
    result: 'ok',
    requestId: input.requestId,
  });
  return rowToRule(r.rows[0]);
}

export async function deleteRule(
  client: PoolClient,
  input: { tenantId: string; ruleId: string; actor: string; requestId?: string },
): Promise<void> {
  const r = await client.query('DELETE FROM rules WHERE tenant_id = $1 AND id = $2', [
    input.tenantId,
    input.ruleId,
  ]);
  if (r.rowCount === 0) throw new Error('No encontramos esa regla.');
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'automations.rule.delete',
    resource: 'rule',
    resourceId: input.ruleId,
    result: 'ok',
    requestId: input.requestId,
  });
}

export interface PreviewItem {
  objectKind: 'conversation' | 'deal';
  objectId: string;
  label: string;
}

/**
 * "A quién le aplicaría hoy" (SPEC §15): los objetos que cumplen HOY el
 * disparador de tiempo (o las condiciones, para disparadores de evento)
 * — sin ejecutar nada.
 */
export async function previewRule(
  client: PoolClient,
  tenantId: string,
  rule: Pick<Rule, 'trigger' | 'conditions'>,
): Promise<PreviewItem[]> {
  const t = rule.trigger;
  if (t.kind === 'time' && t.time.base === 'no_reply') {
    const r = await client.query(
      `SELECT c.id, k.name, k.phone, c.channel, c.state, c.owner_id
         FROM conversations c JOIN contacts k ON k.id = c.contact_id
        WHERE c.tenant_id = $1 AND c.state IN ('new','open')
          AND c.last_inbound_at < now() - make_interval(hours => $2)
          AND NOT EXISTS (
            SELECT 1 FROM messages m
             WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id
               AND m.direction = 'out' AND m.created_at > c.last_inbound_at)
        ORDER BY c.last_inbound_at LIMIT 50`,
      [tenantId, t.time.hours],
    );
    return r.rows
      .filter((row) =>
        evaluateConditions(
          { channel: row.channel, state: row.state, ownerId: row.owner_id },
          rule.conditions,
        ),
      )
      .map((row) => ({
        objectKind: 'conversation' as const,
        objectId: row.id,
        label: row.name ?? row.phone ?? row.id,
      }));
  }
  if (t.kind === 'time' && t.time.base === 'in_stage') {
    const r = await client.query(
      `SELECT d.id, d.title, s.name AS stage, d.value_clp, d.owner_id
         FROM deals d JOIN stages s ON s.id = d.stage_id
        WHERE d.tenant_id = $1 AND d.status = 'open'
          AND d.stage_entered_at < now() - make_interval(hours => $2)
          AND ($3::text IS NULL OR lower(s.name) = lower($3))
        ORDER BY d.stage_entered_at LIMIT 50`,
      [tenantId, t.time.hours, t.time.stageName ?? null],
    );
    return r.rows
      .filter((row) =>
        evaluateConditions(
          { stage: row.stage, valueClp: row.value_clp, ownerId: row.owner_id },
          rule.conditions,
        ),
      )
      .map((row) => ({ objectKind: 'deal' as const, objectId: row.id, label: row.title }));
  }
  // Disparador de evento: muestra qué objetos ACTUALES cumplen las condiciones.
  if (t.kind === 'event' && t.event.startsWith('deal.')) {
    const r = await client.query(
      `SELECT d.id, d.title, s.name AS stage, d.value_clp FROM deals d
         JOIN stages s ON s.id = d.stage_id
        WHERE d.tenant_id = $1 AND d.status = 'open' ORDER BY d.created_at DESC LIMIT 50`,
      [tenantId],
    );
    return r.rows
      .filter((row) => evaluateConditions({ stage: row.stage, valueClp: row.value_clp }, rule.conditions))
      .map((row) => ({ objectKind: 'deal' as const, objectId: row.id, label: row.title }));
  }
  const r = await client.query(
    `SELECT c.id, k.name, k.phone, c.channel, c.state FROM conversations c
       JOIN contacts k ON k.id = c.contact_id
      WHERE c.tenant_id = $1 AND c.state IN ('new','open')
      ORDER BY c.last_message_at DESC NULLS LAST LIMIT 50`,
    [tenantId],
  );
  return r.rows
    .filter((row) => evaluateConditions({ channel: row.channel, state: row.state }, rule.conditions))
    .map((row) => ({
      objectKind: 'conversation' as const,
      objectId: row.id,
      label: row.name ?? row.phone ?? row.id,
    }));
}
