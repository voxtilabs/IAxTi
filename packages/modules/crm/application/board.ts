import type { PoolClient } from 'pg';
import { listCursor } from './list-cursor';
import type { Deal, Pipeline, Stage } from './deals';

// El tablero y la lista (#33, SPEC §10): las dos vistas de trabajo diario
// sobre las oportunidades. Cursor keyset SIEMPRE (SPEC §28): nada de
// cargar todo.

export interface DealCard extends Deal {
  createdAt: Date;
  contactName: string | null;
  contactPhone: string;
  stageName: string;
}

export interface DealFilters {
  pipelineId?: string;
  stageId?: string;
  status?: 'open' | 'won' | 'lost';
  /** Solo las de este dueño… */
  ownerId?: string;
  /** …o las suyas MÁS las sin dueño (USER sin crm.read_all). */
  ownerIdOrUnassigned?: string;
  /** Etiqueta del CONTACTO (las tags viven en el contacto, SPEC §10). */
  tag?: string;
  valueClpMin?: number;
  valueClpMax?: number;
  /** Campo custom de la oportunidad: igualdad exacta. */
  custom?: { key: string; value: string };
  sort?: string;
  order?: string;
  cursor?: string;
  limit?: number;
}

function rowToCard(row: Record<string, unknown>): DealCard {
  return {
    id: row.id as string,
    createdAt: row.created_at as Date,
    tenantId: row.tenant_id as string,
    contactId: row.contact_id as string,
    pipelineId: row.pipeline_id as string,
    stageId: row.stage_id as string,
    title: row.title as string,
    value: row.value === null ? null : Number(row.value),
    currency: row.currency as DealCard['currency'],
    valueClp: row.value_clp === null ? null : Number(row.value_clp),
    ufRate: row.uf_rate === null ? null : Number(row.uf_rate),
    ownerId: (row.owner_id as string) ?? null,
    status: row.status as DealCard['status'],
    lostReasonId: (row.lost_reason_id as string) ?? null,
    stalled: row.stalled as boolean,
    stageEnteredAt: row.stage_entered_at as Date,
    expectedCloseDate: (row.expected_close_date as Date) ?? null,
    contactName: (row.contact_name as string) ?? null,
    contactPhone: row.contact_phone as string,
    stageName: row.stage_name as string,
  };
}

export async function listDeals(
  client: PoolClient,
  tenantId: string,
  filters: DealFilters = {},
): Promise<{ items: DealCard[]; nextCursor: string | null }> {
  const params: unknown[] = [tenantId];
  const where: string[] = ['d.tenant_id = $1'];

  const push = (clause: (n: number) => string, value: unknown) => {
    params.push(value);
    where.push(clause(params.length));
  };
  if (filters.pipelineId) push((n) => `d.pipeline_id = $${n}`, filters.pipelineId);
  if (filters.stageId) push((n) => `d.stage_id = $${n}`, filters.stageId);
  if (filters.status) push((n) => `d.status = $${n}`, filters.status);
  if (filters.ownerId) push((n) => `d.owner_id = $${n}`, filters.ownerId);
  if (filters.ownerIdOrUnassigned) {
    push((n) => `(d.owner_id = $${n} OR d.owner_id IS NULL)`, filters.ownerIdOrUnassigned);
  }
  if (filters.valueClpMin !== undefined) push((n) => `d.value_clp >= $${n}`, filters.valueClpMin);
  if (filters.valueClpMax !== undefined) push((n) => `d.value_clp <= $${n}`, filters.valueClpMax);
  if (filters.tag) {
    push(
      (n) => `EXISTS (
        SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
        WHERE ct.contact_id = d.contact_id AND t.name = $${n}
      )`,
      filters.tag,
    );
  }
  if (filters.custom?.key) {
    push((n) => `d.custom ->> '${filters.custom!.key.replace(/[^a-zA-Z0-9_]/g, '')}' = $${n}`, filters.custom.value);
  }
  const pagination = listCursor({
    columns: { created: { sql: 'd.created_at', type: 'timestamptz' }, title: { sql: 'd.title', type: 'text' }, value: { sql: 'd.value_clp', type: 'numeric' }, stage: { sql: 's.name', type: 'text' } },
    defaultSort: 'created', sort: filters.sort, order: filters.order, cursor: filters.cursor, limit: filters.limit,
    scope: [tenantId, filters.pipelineId ?? null, filters.stageId ?? null, filters.status ?? null,
      filters.ownerId ?? null, filters.ownerIdOrUnassigned ?? null, filters.tag ?? null,
      filters.valueClpMin ?? null, filters.valueClpMax ?? null, filters.custom?.key ?? null, filters.custom?.value ?? null],
    idColumn: 'd.id', params,
  });
  const { limit } = pagination;
  if (pagination.where) where.push(pagination.where);

  params.push(limit + 1);
  const r = await client.query(
    `SELECT d.*, ${pagination.selectValue}, k.name AS contact_name, k.phone AS contact_phone, s.name AS stage_name
       FROM deals d
       JOIN contacts k ON k.id = d.contact_id
       JOIN stages s ON s.id = d.stage_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${pagination.orderBy}
      LIMIT $${params.length}`,
    params,
  );
  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  const last = rows.at(-1);
  return {
    items: rows.map(rowToCard),
    nextCursor: hasMore && last ? pagination.encode(last) : null,
  };
}

/** Todos los pipelines del tenant con sus etapas ordenadas (para el tablero). */
export async function listPipelines(
  client: PoolClient,
  tenantId: string,
): Promise<Array<Pipeline & { stages: Stage[] }>> {
  const p = await client.query(
    'SELECT id, tenant_id, name, vertical FROM pipelines WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId],
  );
  const s = await client.query(
    'SELECT * FROM stages WHERE tenant_id = $1 ORDER BY pipeline_id, position',
    [tenantId],
  );
  return p.rows.map((pipe) => ({
    id: pipe.id,
    tenantId: pipe.tenant_id,
    name: pipe.name,
    vertical: pipe.vertical ?? null,
    stages: s.rows
      .filter((st) => st.pipeline_id === pipe.id)
      .map((st) => ({
        id: st.id,
        pipelineId: st.pipeline_id,
        name: st.name,
        position: st.position,
        type: st.type,
        probability: st.probability ?? null,
        expectedDays: st.expected_days ?? null,
      })),
  }));
}

// --- Filtros guardados POR USUARIO (#33) ---

export interface SavedFilter {
  id: string;
  view: 'deals' | 'contacts';
  name: string;
  filters: Record<string, unknown>;
}

export async function listSavedFilters(
  client: PoolClient,
  tenantId: string,
  userId: string,
  view: SavedFilter['view'] = 'deals',
): Promise<SavedFilter[]> {
  const r = await client.query(
    `SELECT id, view, name, filters FROM saved_filters
      WHERE tenant_id = $1 AND user_id = $2 AND view = $3 ORDER BY name`,
    [tenantId, userId, view],
  );
  return r.rows;
}

export async function saveFilter(
  client: PoolClient,
  input: {
    tenantId: string;
    userId: string;
    view?: SavedFilter['view'];
    name: string;
    filters: Record<string, unknown>;
  },
): Promise<SavedFilter> {
  if (!input.name.trim()) throw new Error('Ponle nombre al filtro para guardarlo.');
  const r = await client.query(
    `INSERT INTO saved_filters (tenant_id, user_id, view, name, filters)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, user_id, view, name)
       DO UPDATE SET filters = EXCLUDED.filters
     RETURNING id, view, name, filters`,
    [input.tenantId, input.userId, input.view ?? 'deals', input.name.trim(), JSON.stringify(input.filters)],
  );
  return r.rows[0];
}

export async function deleteSavedFilter(
  client: PoolClient,
  input: { tenantId: string; userId: string; id: string },
): Promise<void> {
  const r = await client.query(
    'DELETE FROM saved_filters WHERE tenant_id = $1 AND user_id = $2 AND id = $3',
    [input.tenantId, input.userId, input.id],
  );
  if (r.rowCount === 0) throw new Error('No encontramos ese filtro, o no es tuyo.');
}
