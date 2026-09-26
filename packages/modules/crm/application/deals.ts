import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { resolveValueClp, validateStages } from '../domain/pipeline';
import type { StageInput, StageType } from '../domain/pipeline';

export interface Pipeline {
  id: string;
  tenantId: string;
  name: string;
  vertical: string | null;
}

export interface Stage {
  id: string;
  pipelineId: string;
  name: string;
  position: number;
  type: StageType;
  probability: number | null;
  expectedDays: number | null;
}

export type DealCurrency = 'CLP' | 'UF' | 'USD';

export interface Deal {
  id: string;
  tenantId: string;
  contactId: string;
  pipelineId: string;
  stageId: string;
  title: string;
  value: number | null;
  currency: DealCurrency;
  valueClp: number | null;
  ufRate: number | null;
  ownerId: string | null;
  status: 'open' | 'won' | 'lost';
  lostReasonId: string | null;
  stalled: boolean;
  stageEnteredAt: Date;
  expectedCloseDate: Date | null;
}

function rowToStage(row: Record<string, unknown>): Stage {
  return {
    id: row.id as string,
    pipelineId: row.pipeline_id as string,
    name: row.name as string,
    position: row.position as number,
    type: row.type as StageType,
    probability: (row.probability as number) ?? null,
    expectedDays: (row.expected_days as number) ?? null,
  };
}

function rowToDeal(row: Record<string, unknown>): Deal {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    contactId: row.contact_id as string,
    pipelineId: row.pipeline_id as string,
    stageId: row.stage_id as string,
    title: row.title as string,
    value: row.value === null ? null : Number(row.value),
    currency: row.currency as DealCurrency,
    valueClp: row.value_clp === null ? null : Number(row.value_clp),
    ufRate: row.uf_rate === null ? null : Number(row.uf_rate),
    ownerId: (row.owner_id as string) ?? null,
    status: row.status as Deal['status'],
    lostReasonId: (row.lost_reason_id as string) ?? null,
    stalled: row.stalled as boolean,
    stageEnteredAt: row.stage_entered_at as Date,
    expectedCloseDate: (row.expected_close_date as Date) ?? null,
  };
}

export async function createPipeline(
  client: PoolClient,
  input: { tenantId: string; name: string; vertical?: string; stages: StageInput[] },
): Promise<{ pipeline: Pipeline; stages: Stage[] }> {
  validateStages(input.stages);
  const p = await client.query(
    'INSERT INTO pipelines (tenant_id, name, vertical) VALUES ($1, $2, $3) RETURNING *',
    [input.tenantId, input.name, input.vertical ?? null],
  );
  const pipeline: Pipeline = {
    id: p.rows[0].id,
    tenantId: p.rows[0].tenant_id,
    name: p.rows[0].name,
    vertical: p.rows[0].vertical ?? null,
  };
  const stages: Stage[] = [];
  for (const [position, s] of input.stages.entries()) {
    const r = await client.query(
      `INSERT INTO stages (tenant_id, pipeline_id, name, position, type, probability, expected_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [input.tenantId, pipeline.id, s.name, position, s.type, s.probability ?? null, s.expectedDays ?? null],
    );
    stages.push(rowToStage(r.rows[0]));
  }
  return { pipeline, stages };
}

export async function getPipelineStages(
  client: PoolClient,
  tenantId: string,
  pipelineId: string,
): Promise<Stage[]> {
  const r = await client.query(
    'SELECT * FROM stages WHERE tenant_id = $1 AND pipeline_id = $2 ORDER BY position',
    [tenantId, pipelineId],
  );
  return r.rows.map(rowToStage);
}

// --- Motivos de pérdida: lista configurable, con partida razonable chilena ---

export const DEFAULT_LOSS_REASONS = [
  'Precio',
  'Sin respuesta',
  'Eligió a la competencia',
  'No era el momento',
  'Otro',
];

export async function ensureDefaultLossReasons(client: PoolClient, tenantId: string): Promise<void> {
  for (const label of DEFAULT_LOSS_REASONS) {
    await client.query(
      'INSERT INTO loss_reasons (tenant_id, label) VALUES ($1, $2) ON CONFLICT (tenant_id, label) DO NOTHING',
      [tenantId, label],
    );
  }
}

export async function listLossReasons(
  client: PoolClient,
  tenantId: string,
): Promise<{ id: string; label: string }[]> {
  const r = await client.query(
    'SELECT id, label FROM loss_reasons WHERE tenant_id = $1 AND active ORDER BY created_at',
    [tenantId],
  );
  return r.rows;
}

export interface CreateDealInput {
  tenantId: string;
  contactId: string;
  pipelineId: string;
  title: string;
  value?: number;
  currency?: DealCurrency;
  /** Valor de la UF del día en CLP; obligatorio cuando currency = 'UF'. */
  ufRate?: number;
  ownerId?: string;
  expectedCloseDate?: string;
  sourceConversationId?: string;
  /** Etapa inicial; por omisión, la primera etapa abierta del pipeline. */
  stageId?: string;
  requestId?: string;
  actor?: string;
}

export async function createDeal(client: PoolClient, input: CreateDealInput): Promise<Deal> {
  const stages = await getPipelineStages(client, input.tenantId, input.pipelineId);
  if (stages.length === 0) throw new Error('Ese pipeline no existe o no tiene etapas.');
  const stage = input.stageId
    ? stages.find((s) => s.id === input.stageId)
    : stages.find((s) => s.type === 'open');
  if (!stage) throw new Error('No encontramos esa etapa en el pipeline.');
  if (stage.type !== 'open') throw new Error('Una oportunidad nueva parte en una etapa abierta.');

  const currency = input.currency ?? 'CLP';
  const { valueClp, ufRate } = resolveValueClp(input.value, currency, input.ufRate);

  let row;
  try {
    const r = await client.query(
      `INSERT INTO deals (tenant_id, contact_id, pipeline_id, stage_id, title, value,
                          currency, value_clp, uf_rate, owner_id, expected_close_date,
                          source_conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        input.tenantId,
        input.contactId,
        input.pipelineId,
        stage.id,
        input.title,
        input.value ?? null,
        currency,
        valueClp,
        ufRate,
        input.ownerId ?? null,
        input.expectedCloseDate ?? null,
        input.sourceConversationId ?? null,
      ],
    );
    row = r.rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new Error(
        'Ese contacto ya tiene una oportunidad abierta en este pipeline. Ciérrala antes de abrir otra.',
      );
    }
    throw err;
  }
  const deal = rowToDeal(row);
  await client.query(
    `INSERT INTO deal_stage_history (tenant_id, deal_id, from_stage_id, to_stage_id, actor)
     VALUES ($1, $2, NULL, $3, $4)`,
    [input.tenantId, deal.id, stage.id, input.actor ?? null],
  );
  await publishEvent(client, {
    name: 'deal.created',
    tenantId: input.tenantId,
    payload: { dealId: deal.id, contactId: deal.contactId, pipelineId: deal.pipelineId },
    actor: input.actor,
    requestId: input.requestId,
  });
  return deal;
}

export interface MoveDealInput {
  tenantId: string;
  dealId: string;
  stageId: string;
  /** Obligatorio al retroceder de etapa (SPEC §10). */
  reason?: string;
  /** Obligatorio al cerrar en lost: id de la lista configurable. */
  lostReasonId?: string;
  requestId?: string;
  actor?: string;
  /**
   * ¿Esta persona puede CERRAR? Se consulta SOLO al mover a won o lost.
   *
   * Va inyectado porque este módulo no conoce el catálogo de permisos: lo
   * pasa quien sí sabe a nombre de quién se está actuando. Los caminos
   * automáticos no lo pasan, y ahí no hay persona a quien verificar.
   */
  puedeCerrar?: () => boolean | Promise<boolean>;
}

export async function moveDealStage(client: PoolClient, input: MoveDealInput): Promise<Deal> {
  const d = await client.query(
    'SELECT * FROM deals WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
    [input.tenantId, input.dealId],
  );
  if (d.rowCount === 0) throw new Error('No encontramos esa oportunidad. Puede que se haya eliminado.');
  const deal = rowToDeal(d.rows[0]);
  if (deal.status !== 'open') {
    throw new Error('Esta oportunidad ya está cerrada. Abre una nueva si el negocio revivió.');
  }

  const stages = await getPipelineStages(client, input.tenantId, deal.pipelineId);
  const actual = stages.find((s) => s.id === deal.stageId);
  const destino = stages.find((s) => s.id === input.stageId);
  if (!actual || !destino) throw new Error('Esa etapa no pertenece al pipeline de la oportunidad.');
  if (destino.id === actual.id) return deal;

  // Cerrar pide `crm.deals.close`, mover entre etapas abiertas pide
  // `crm.deals.update`. El catálogo declaraba los dos permisos y el código
  // usaba uno solo para todo: quien podía mover una etapa podía dar el
  // negocio por ganado o perdido.
  //
  // No es un detalle de nombres. Un dueño que arma un rol "puede trabajar
  // los tratos pero no cerrarlos" lo arma, ve el permiso en la lista, y no
  // sirve para nada — el vendedor cierra igual. Y cerrar mueve el número
  // que el negocio reporta.
  //
  // Sin `puedeCerrar` no cambia nada: los caminos que no vienen de una
  // persona —una automatización moviendo por regla— actúan con la
  // configuración del tenant, no con permisos de alguien.
  if ((destino.type === 'won' || destino.type === 'lost') && input.puedeCerrar) {
    if (!(await input.puedeCerrar())) {
      throw new Error('PERMISO_CERRAR: no tienes permiso para cerrar oportunidades.');
    }
  }

  if (destino.position < actual.position && !input.reason?.trim()) {
    throw new Error('Para retroceder de etapa cuéntanos el motivo; queda en la historia.');
  }

  let lostReasonLabel: string | null = null;
  if (destino.type === 'lost') {
    if (!input.lostReasonId) {
      throw new Error('Para cerrar como perdida elige un motivo de la lista.');
    }
    const lr = await client.query(
      'SELECT label FROM loss_reasons WHERE tenant_id = $1 AND id = $2 AND active',
      [input.tenantId, input.lostReasonId],
    );
    if (lr.rowCount === 0) throw new Error('Ese motivo de pérdida no está en la lista del negocio.');
    lostReasonLabel = lr.rows[0].label;
  }

  const status = destino.type === 'open' ? 'open' : destino.type;
  const r = await client.query(
    `UPDATE deals SET
       stage_id = $3, status = $4,
       stage_entered_at = now(), stalled = false,
       won_at  = CASE WHEN $4 = 'won'  THEN now() ELSE won_at  END,
       lost_at = CASE WHEN $4 = 'lost' THEN now() ELSE lost_at END,
       lost_reason_id = CASE WHEN $4 = 'lost' THEN $5::uuid ELSE lost_reason_id END,
       updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [input.tenantId, input.dealId, destino.id, status, input.lostReasonId ?? null],
  );
  const movido = rowToDeal(r.rows[0]);

  await client.query(
    `INSERT INTO deal_stage_history (tenant_id, deal_id, from_stage_id, to_stage_id, reason, actor)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.tenantId, deal.id, actual.id, destino.id, input.reason ?? lostReasonLabel, input.actor ?? null],
  );

  const base = {
    tenantId: input.tenantId,
    actor: input.actor,
    requestId: input.requestId,
  };
  await publishEvent(client, {
    ...base,
    name: 'deal.stage_changed',
    payload: { dealId: deal.id, from: actual.id, to: destino.id, backward: destino.position < actual.position },
  });
  if (status === 'won') {
    await publishEvent(client, {
      ...base,
      name: 'deal.won',
      payload: { dealId: deal.id, contactId: deal.contactId, valueClp: movido.valueClp },
    });
  }
  if (status === 'lost') {
    await publishEvent(client, {
      ...base,
      name: 'deal.lost',
      payload: { dealId: deal.id, contactId: deal.contactId, reason: lostReasonLabel },
    });
  }
  return movido;
}

export async function updateDeal(
  client: PoolClient,
  input: {
    tenantId: string;
    dealId: string;
    title?: string;
    value?: number;
    currency?: DealCurrency;
    ufRate?: number;
    ownerId?: string;
    expectedCloseDate?: string;
  },
): Promise<Deal> {
  const d = await client.query('SELECT * FROM deals WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
    input.tenantId,
    input.dealId,
  ]);
  if (d.rowCount === 0) throw new Error('No encontramos esa oportunidad. Puede que se haya eliminado.');
  const actual = rowToDeal(d.rows[0]);

  const cambiaValor = input.value !== undefined || input.currency !== undefined;
  const currency = input.currency ?? actual.currency;
  const value = input.value ?? actual.value ?? undefined;
  const dinero = cambiaValor
    ? resolveValueClp(value, currency, input.ufRate)
    : { valueClp: actual.valueClp, ufRate: actual.ufRate };

  const r = await client.query(
    `UPDATE deals SET
       title = COALESCE($3, title),
       value = CASE WHEN $4::boolean THEN $5 ELSE value END,
       currency = CASE WHEN $4::boolean THEN $6 ELSE currency END,
       value_clp = CASE WHEN $4::boolean THEN $7 ELSE value_clp END,
       uf_rate  = CASE WHEN $4::boolean THEN $8 ELSE uf_rate END,
       owner_id = COALESCE($9, owner_id),
       expected_close_date = COALESCE($10, expected_close_date),
       updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [
      input.tenantId,
      input.dealId,
      input.title ?? null,
      cambiaValor,
      value ?? null,
      currency,
      dinero.valueClp,
      dinero.ufRate,
      input.ownerId ?? null,
      input.expectedCloseDate ?? null,
    ],
  );
  return rowToDeal(r.rows[0]);
}

/**
 * Marca estancadas las oportunidades abiertas que llevan en su etapa más días
 * de los esperados y publica `deal.stalled` una sola vez por episodio
 * (moverse de etapa limpia la marca).
 *
 * La llama el job `crm.stalled` de workers, una vez al día a las 07:00 de
 * Santiago. Ese job NO existía hasta #529: este comentario decía que la
 * llamaba y no la llamaba nadie más que su test, así que la bandera nunca se
 * ponía en true y todo lo que cuelga de ella estaba apagado en silencio.
 */
export async function markStalledDeals(
  client: PoolClient,
  tenantId: string,
  requestId?: string,
): Promise<string[]> {
  const r = await client.query(
    `UPDATE deals d SET stalled = true, updated_at = now()
     FROM stages s
     WHERE d.stage_id = s.id AND d.tenant_id = $1
       AND d.status = 'open' AND d.stalled = false
       AND s.expected_days IS NOT NULL
       AND d.stage_entered_at < now() - make_interval(days => s.expected_days)
     RETURNING d.id, d.contact_id, s.name AS stage_name`,
    [tenantId],
  );
  for (const row of r.rows) {
    await publishEvent(client, {
      name: 'deal.stalled',
      tenantId,
      payload: { dealId: row.id, contactId: row.contact_id, stage: row.stage_name },
      actor: 'system',
      requestId,
    });
  }
  return r.rows.map((row) => row.id);
}

/** Estancadas abiertas, para el resumen del supervisor (widget crm.resumen). */
export async function listStalledDeals(
  client: PoolClient,
  tenantId: string,
): Promise<(Deal & { stageName: string; daysInStage: number })[]> {
  const r = await client.query(
    `SELECT d.*, s.name AS stage_name,
            floor(extract(epoch FROM now() - d.stage_entered_at) / 86400)::int AS days_in_stage
     FROM deals d JOIN stages s ON s.id = d.stage_id
     WHERE d.tenant_id = $1 AND d.status = 'open' AND d.stalled
     ORDER BY d.stage_entered_at`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    ...rowToDeal(row),
    stageName: row.stage_name as string,
    daysInStage: row.days_in_stage as number,
  }));
}
