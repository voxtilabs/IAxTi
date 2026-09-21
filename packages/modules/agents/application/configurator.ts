import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { createPipeline, listPipelines } from '@iaxti/module-crm';
import { createQuickReply } from '@iaxti/module-conversations';
import { writeAudit } from '@iaxti/module-audit';
import {
  VERTICAL_BASES,
  VERTICALS,
  buildDiff,
  formatoConfiguracion,
  parseConfiguration,
  type ConfigDiff,
  type ConfigProposal,
  type ConfigSnapshot,
  type Vertical,
} from '../domain/configurator';
import { runAgentTask } from './runtime';
import type { ModelPortFactory } from './models';
import { aiSdkModelPort } from './models';
import { activeAgent } from './copilot';
import { listAgents, type Agent } from './agents';

// El configurador (#50): "el CRM se arma solo en 15 minutos" — el agente
// PROPONE un diff antes/después y el usuario lo aplica. Nunca actúa solo.

export interface Proposal {
  id: string;
  description: string;
  vertical: Vertical;
  proposal: ConfigProposal;
  diff: ConfigDiff;
  status: 'pending' | 'applied' | 'dismissed';
  createdAt: Date;
}

function rowToProposal(row: Record<string, unknown>): Proposal {
  return {
    id: row.id as string,
    description: row.description as string,
    vertical: row.vertical as Vertical,
    proposal: row.proposal as ConfigProposal,
    diff: row.diff as ConfigDiff,
    status: row.status as Proposal['status'],
    createdAt: row.created_at as Date,
  };
}

/** Lo que YA existe: la base del diff y del comportamiento incremental. */
export async function snapshotConfig(
  client: PoolClient,
  tenantId: string,
  opts: { whatsappActivo?: boolean } = {},
): Promise<ConfigSnapshot> {
  const pipelines = await listPipelines(client, tenantId);
  // Todos los atajos del tenant (globales y personales): no se duplican.
  const atajos = await client.query(
    'SELECT shortcut FROM quick_replies WHERE tenant_id = $1 ORDER BY shortcut',
    [tenantId],
  );
  return {
    pipelines: pipelines.map((p) => ({ name: p.name, stages: p.stages.map((s) => s.name) })),
    quickReplies: atajos.rows.map((q) => q.shortcut),
    whatsappActivo: opts.whatsappActivo ?? false,
  };
}

/**
 * Quién arma la propuesta (#415).
 *
 * Si el negocio creó un asistente con el objetivo `configuracion`, es ESE:
 * tiene su propio modelo y su propia instrucción, y el dueño lo eligió para
 * esto. Si no, el que atiende, como fue siempre — el configurador funciona
 * desde #50 sin que exista ningún objetivo y no va a dejar de funcionar
 * ahora.
 *
 * `activeAgent` ya no sirve solo para esto: desde #416 excluye a los
 * asistentes del dueño, y el de configuración es justamente uno.
 */
export async function agenteQueConfigura(
  client: PoolClient,
  tenantId: string,
): Promise<Agent | null> {
  const agentes = await listAgents(client, tenantId);
  const propio = agentes.find((a) => a.active && a.objetivo === 'configuracion');
  return propio ?? (await activeAgent(client, tenantId));
}

/**
 * Propone la configuración con el modelo de GAMA ALTA (task `configurar`,
 * Pro por defecto — la única tarea que lo amerita, §40). La propuesta queda
 * `pending` hasta que el usuario decida.
 */
export async function proposeConfiguration(
  client: PoolClient,
  input: {
    tenantId: string;
    description: string;
    vertical?: string;
    whatsappActivo?: boolean;
    actorUserId?: string;
    requestId?: string;
    activeModules?: readonly string[];
  },
  modelPortFactory: ModelPortFactory = aiSdkModelPort,
): Promise<{ status: 'ok'; proposal: Proposal } | { status: 'failed'; error: string }> {
  if (!input.description?.trim()) {
    return { status: 'failed', error: 'Cuéntanos primero de qué se trata el negocio.' };
  }
  const agent = await agenteQueConfigura(client, input.tenantId);
  if (!agent) return { status: 'failed', error: 'Primero crea tu asistente en Ajustes → IA.' };
  const vertical: Vertical = (VERTICALS as readonly string[]).includes(input.vertical ?? '')
    ? (input.vertical as Vertical)
    : 'otro';
  const snapshot = await snapshotConfig(client, input.tenantId, {
    whatsappActivo: input.whatsappActivo,
  });

  const contexto = [
    `Descripción del negocio: ${input.description.trim()}`,
    snapshot.pipelines.length > 0 || snapshot.quickReplies.length > 0
      ? `YA CONFIGURADO (no lo repitas, propone solo lo que falta o mejora): ${JSON.stringify(snapshot)}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const res = await runAgentTask(
    client,
    {
      tenantId: input.tenantId,
      agent,
      task: 'configurar',
      context: contexto,
      ...(input.activeModules ? { activeModules: input.activeModules } : {}),
      prompt: formatoConfiguracion(VERTICAL_BASES[vertical]),
      requestId: input.requestId,
      actorUserId: input.actorUserId,
    },
    modelPortFactory,
  );
  if (res.status === 'failed' || !res.text) {
    return { status: 'failed', error: res.error ?? 'El configurador no respondió. Intenta de nuevo.' };
  }
  // Cortada por el tope de salida. Es la respuesta más larga del producto
  // —pipeline, respuestas rápidas Y tres plantillas— con el modelo que más
  // razona, así que es la que más se corta.
  //
  // Antes caía en el mismo saco que "no se entendió" y le decía al dueño
  // que lo intentara "con más detalle": el consejo exactamente al revés,
  // porque más detalle alarga el contexto y lo corta antes. Y esto es el
  // ONBOARDING — la primera cosa que hace alguien que recién llega.
  if (res.truncada) {
    return {
      status: 'failed',
      error:
        'La propuesta quedó a medias: es muy larga para el espacio disponible. ' +
        'Prueba con una descripción más corta del negocio.',
    };
  }
  const propuesta = parseConfiguration(res.text);
  if (!propuesta) {
    return { status: 'failed', error: 'La propuesta no se entendió. Intenta de nuevo con más detalle.' };
  }
  const diff = buildDiff(snapshot, propuesta);
  const fila = await client.query(
    `INSERT INTO agent_proposals (tenant_id, agent_id, execution_id, description, vertical, proposal, diff)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.tenantId,
      agent.id,
      res.executionId,
      input.description.trim(),
      vertical,
      JSON.stringify(propuesta),
      JSON.stringify(diff),
    ],
  );
  await publishEvent(client, {
    name: 'agent.suggested',
    tenantId: input.tenantId,
    payload: { kind: 'configuracion', proposalId: fila.rows[0].id },
    actor: input.actorUserId ?? 'system',
    requestId: input.requestId,
  });
  return { status: 'ok', proposal: rowToProposal(fila.rows[0]) };
}

export async function getProposal(
  client: PoolClient,
  tenantId: string,
  proposalId: string,
): Promise<Proposal | null> {
  const r = await client.query(
    'SELECT * FROM agent_proposals WHERE tenant_id = $1 AND id = $2',
    [tenantId, proposalId],
  );
  return r.rowCount === 0 ? null : rowToProposal(r.rows[0]);
}

/** La última propuesta pendiente (para retomar el diff al volver). */
export async function pendingProposal(client: PoolClient, tenantId: string): Promise<Proposal | null> {
  const r = await client.query(
    `SELECT * FROM agent_proposals WHERE tenant_id = $1 AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  );
  return r.rowCount === 0 ? null : rowToProposal(r.rows[0]);
}

/**
 * Aplica el diff con las MISMAS APIs de admin y los permisos del usuario
 * que aprieta el botón — auditado como `user via agent` (SPEC §13). Solo
 * toca lo marcado `crear`: lo que ya existía queda tal cual (incremental).
 */
export async function applyProposal(
  client: PoolClient,
  input: { tenantId: string; proposalId: string; actorUserId: string; requestId?: string },
): Promise<{ creado: { pipeline: boolean; quickReplies: number }; proposal: Proposal }> {
  const proposal = await getProposal(client, input.tenantId, input.proposalId);
  if (!proposal) throw new Error('No encontramos esa propuesta.');
  if (proposal.status !== 'pending') throw new Error('Esa propuesta ya no está vigente.');

  // El snapshot se relee AL APLICAR: si algo apareció entre medio, no se pisa.
  const snapshot = await snapshotConfig(client, input.tenantId);
  let pipelineCreado = false;
  if (!snapshot.pipelines.some((p) => p.name.toLowerCase() === proposal.proposal.pipeline.name.toLowerCase())) {
    await createPipeline(client, {
      tenantId: input.tenantId,
      name: proposal.proposal.pipeline.name,
      vertical: proposal.vertical,
      stages: proposal.proposal.pipeline.stages,
    });
    pipelineCreado = true;
  }
  let atajosCreados = 0;
  for (const q of proposal.proposal.quickReplies) {
    if (snapshot.quickReplies.includes(q.shortcut)) continue;
    await createQuickReply(client, { tenantId: input.tenantId, shortcut: q.shortcut, body: q.body });
    atajosCreados += 1;
  }
  const fila = await client.query(
    `UPDATE agent_proposals SET status = 'applied', applied_by = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.proposalId, input.actorUserId],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actorUserId,
    actorKind: 'user', // el humano aplica; el agente solo propuso
    action: 'agents.configurator.apply',
    resource: 'agent_proposal',
    resourceId: input.proposalId,
    result: 'ok',
    metadata: { via: 'agent', pipelineCreado, atajosCreados },
    requestId: input.requestId,
  });
  return {
    creado: { pipeline: pipelineCreado, quickReplies: atajosCreados },
    proposal: rowToProposal(fila.rows[0]),
  };
}

export async function dismissProposal(
  client: PoolClient,
  input: { tenantId: string; proposalId: string; actorUserId: string },
): Promise<void> {
  const r = await client.query(
    `UPDATE agent_proposals SET status = 'dismissed', updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
    [input.tenantId, input.proposalId],
  );
  if (r.rowCount === 0) throw new Error('Esa propuesta ya no está vigente.');
}
