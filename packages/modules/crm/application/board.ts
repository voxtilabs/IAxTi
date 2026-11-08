import type { PoolClient } from 'pg';
import { diaEn } from '@iaxti/core';
import { zonaDelTenant } from '@iaxti/module-organizations';
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
  /**
   * Lo próximo que hay que hacer con esta oportunidad (#1302).
   *
   * `null` cuando no hay ninguna pendiente, que NO es lo mismo que no
   * saberlo: una oportunidad sin actividad agendada es justamente la que se
   * queda sin que nadie la toque, y el tablero lo tiene que poder decir.
   *
   * **`estado` y `dias` los calcula el SERVIDOR, y no es por comodidad.** El
   * navegador no conoce `tenants.timezone` —no viaja en `publicConfig()` ni
   * en la sesión, está medido en `apps/web/lib/reportes.ts`— así que no puede
   * contestar «¿vence hoy?» sin inventarse una zona. Entre las 21:00 y la
   * medianoche chilenas, UTC ya es mañana: una tarea de hoy se mostraría
   * atrasada todas las noches. Es el mismo defecto de #1072/#1074/#1076 con
   * otra cara.
   *
   * `dueAt` puede ser nulo con la actividad existiendo: `activities.due_at`
   * admite nulo y una tarea sin fecha es una tarea igual. Ese es el estado
   * `sin_fecha`, distinto de no tener ninguna actividad.
   */
  proximaActividad: {
    title: string;
    dueAt: Date | null;
    estado: 'atrasada' | 'hoy' | 'proxima' | 'sin_fecha';
    /** Días de atraso (`atrasada`) o que faltan (`proxima`); nulo en el resto. */
    dias: number | null;
  } | null;
}

export interface DealFilters {
  pipelineId?: string;
  /** Las de UNA persona: lo que el copiloto necesita para no repreguntar (#440). */
  contactId?: string;
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

/**
 * En qué estado está la próxima actividad, contado en DÍAS DEL NEGOCIO.
 *
 * Días y no milisegundos: «vence hoy» es una pregunta de calendario, no de
 * reloj. Una tarea para hoy a las 09:00 mirada a las 18:00 no está atrasada
 * un día, está atrasada hoy — y con la resta de instantes daría `1` y se
 * mostraría «Atrasada 1 día», que es falso.
 *
 * Los dos días se arman con `diaEn(zona, …)` sobre el MISMO `ahora`, que es
 * lo que evita que la comparación se haga entre dos relojes distintos.
 */
function estadoDeLaActividad(
  dueAt: Date | null,
  zona: string,
  ahora: Date,
): Pick<NonNullable<DealCard['proximaActividad']>, 'estado' | 'dias'> {
  if (!dueAt) return { estado: 'sin_fecha', dias: null };
  const hoy = diaEn(zona, ahora);
  const vence = diaEn(zona, dueAt);
  if (vence === hoy) return { estado: 'hoy', dias: null };
  // Mediodía UTC: recorrer días como texto `AAAA-MM-DD` con `new Date` los
  // corre medio día para un lado u otro según la zona, y a las 00:00 eso
  // cambia el resultado. Al mediodía ningún desfase del planeta lo mueve.
  const aDias = (dia: string) => Math.round(new Date(`${dia}T12:00:00Z`).getTime() / 86_400_000);
  const diferencia = aDias(vence) - aDias(hoy);
  return diferencia < 0
    ? { estado: 'atrasada', dias: -diferencia }
    : { estado: 'proxima', dias: diferencia };
}

function rowToCard(row: Record<string, unknown>, zona: string, ahora: Date): DealCard {
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
    // El cierre viaja en la tarjeta: la lista ordena por «ganadas» y hasta
    // ahora no podía decir cuándo (#695).
    wonAt: (row.won_at as Date) ?? null,
    lostAt: (row.lost_at as Date) ?? null,
    contactName: (row.contact_name as string) ?? null,
    contactPhone: row.contact_phone as string,
    stageName: row.stage_name as string,
    proximaActividad: row.proxima_titulo
      ? {
          title: row.proxima_titulo as string,
          dueAt: (row.proxima_due_at as Date) ?? null,
          ...estadoDeLaActividad((row.proxima_due_at as Date) ?? null, zona, ahora),
        }
      : null,
  };
}

/**
 * `ahora` inyectable para las pruebas (#1302): «vence hoy» depende del día, y
 * una prueba que mida el reloj de la máquina pasa o falla según la hora a la
 * que se corra — que es lo que le pasó a la del cupo en #1305.
 */
export async function listDeals(
  client: PoolClient,
  tenantId: string,
  filters: DealFilters = {},
  ahora: Date = new Date(),
): Promise<{ items: DealCard[]; nextCursor: string | null }> {
  const params: unknown[] = [tenantId];
  const where: string[] = ['d.tenant_id = $1'];

  const push = (clause: (n: number) => string, value: unknown) => {
    params.push(value);
    where.push(clause(params.length));
  };
  if (filters.pipelineId) push((n) => `d.pipeline_id = $${n}`, filters.pipelineId);
  if (filters.contactId) push((n) => `d.contact_id = $${n}`, filters.contactId);
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
  /*
   * Una sola vez para todo el lote, y ANTES de la consulta: `zonaDelTenant`
   * cachea cinco minutos y degrada con savepoints, que no admiten dos en
   * vuelo sobre el mismo cliente (#991). Acá es secuencial y no corre dentro
   * de ningún `Promise.all`, que es donde eso se vuelve un defecto callado.
   */
  const zona = await zonaDelTenant(client, tenantId);
  const r = await client.query(
    /*
     * El LATERAL y no una segunda consulta por tarjeta (#1302).
     *
     * Son veinte tarjetas por columna y cuatro o cinco columnas: pedir la
     * próxima actividad una por una son cien viajes a la base para dibujar
     * una pantalla. El LATERAL la trae en el mismo barrido, apoyado en
     * `activities_proxima_del_deal_idx` (migración 0011).
     *
     * `NULLS LAST`: una tarea sin fecha es menos urgente que una con fecha,
     * aunque se haya creado antes. Sin eso, una tarea vieja sin plazo tapaba
     * la que vence hoy.
     */
    `SELECT d.*, ${pagination.selectValue}, k.name AS contact_name, k.phone AS contact_phone, s.name AS stage_name,
            prox.title AS proxima_titulo, prox.due_at AS proxima_due_at
       FROM deals d
       JOIN contacts k ON k.id = d.contact_id
       JOIN stages s ON s.id = d.stage_id
       LEFT JOIN LATERAL (
         SELECT a.title, a.due_at
           FROM activities a
          WHERE a.tenant_id = d.tenant_id AND a.deal_id = d.id AND a.done_at IS NULL
          ORDER BY a.due_at ASC NULLS LAST, a.created_at ASC
          LIMIT 1
       ) prox ON true
      WHERE ${where.join(' AND ')}
      ORDER BY ${pagination.orderBy}
      LIMIT $${params.length}`,
    params,
  );
  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  const last = rows.at(-1);
  return {
    items: rows.map((row) => rowToCard(row, zona, ahora)),
    nextCursor: hasMore && last ? pagination.encode(last) : null,
  };
}

/**
 * Cuántas y cuánto hay en cada etapa (#1155).
 *
 * La cabecera del tablero decía solo el conteo de lo que estaba CARGADO —20
 * por columna—, así que sumar ahí el dinero habría mostrado «$210.000»
 * teniendo cien oportunidades más abajo. Un total que miente es peor que no
 * tenerlo: nadie lo contrasta, se lee y se decide con él.
 *
 * Una consulta para el tablero entero y no una por columna: son cuatro o
 * cinco etapas y el GROUP BY las trae todas de una.
 *
 * `value_clp` y no `value`: el monto en pesos es el que existe para todas las
 * monedas —la UF guarda su valor del día (regla de base de datos)— y sumar
 * monedas distintas daría un número sin unidad.
 */
export async function resumenDelTablero(
  client: PoolClient,
  tenantId: string,
  pipelineId: string,
): Promise<{ stageId: string; cuantas: number; totalClp: number }[]> {
  const r = await client.query(
    `SELECT d.stage_id, count(*)::int AS cuantas, COALESCE(sum(d.value_clp), 0)::bigint AS total
       FROM deals d
      WHERE d.tenant_id = $1 AND d.pipeline_id = $2
      GROUP BY d.stage_id`,
    [tenantId, pipelineId],
  );
  return r.rows.map((f) => ({
    stageId: f.stage_id as string,
    cuantas: Number(f.cuantas),
    totalClp: Number(f.total),
  }));
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
