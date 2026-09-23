import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { writeAudit, type ActorKind } from '@iaxti/module-audit';

// Actividades del CRM (#32, SPEC §10): llamada, reunión, tarea o nota.
// El aviso de vencida se publica una sola vez por el barrido programado.

export type ActivityType = 'llamada' | 'reunion' | 'tarea' | 'nota';

export class ActivityReferenceError extends Error {
  constructor(public readonly code: 'CONTACT_NOT_FOUND' | 'DEAL_NOT_FOUND') {
    super(code === 'CONTACT_NOT_FOUND'
      ? 'No encontramos ese contacto en tu negocio. Revisa el contacto e intenta otra vez.'
      : 'No encontramos esa oportunidad para este contacto. Revisa la oportunidad e intenta otra vez.');
  }
}

export interface Activity {
  id: string;
  contactId: string;
  dealId: string | null;
  type: ActivityType;
  title: string;
  body: string | null;
  ownerId: string | null;
  dueAt: Date | null;
  doneAt: Date | null;
  createdAt: Date;
  /** Quién la creó. `null` en las de antes de #454: no se inventa. */
  createdByKind: string | null;
}

function rowToActivity(row: Record<string, unknown>): Activity {
  return {
    id: row.id as string,
    contactId: row.contact_id as string,
    dealId: (row.deal_id as string) ?? null,
    type: row.type as ActivityType,
    title: row.title as string,
    body: (row.body as string) ?? null,
    ownerId: (row.owner_id as string) ?? null,
    dueAt: (row.due_at as Date) ?? null,
    doneAt: (row.done_at as Date) ?? null,
    createdAt: row.created_at as Date,
    createdByKind: (row.created_by_kind as string) ?? null,
  };
}

export async function createActivity(
  client: PoolClient,
  input: {
    tenantId: string;
    contactId: string;
    dealId?: string;
    type: ActivityType;
    title: string;
    body?: string;
    ownerId?: string;
    dueAt?: Date;
    actor?: string;
    actorKind?: ActorKind;
    requestId?: string;
    ip?: string;
    userAgent?: string;
  },
): Promise<Activity> {
  if (!input.title?.trim()) throw new Error('La actividad necesita un título.');
  // Una FK al id no comprueba tenant ni que la oportunidad sea del contacto.
  // Validar aquí protege también a las automatizaciones y tools que usan el contrato.
  const contact = await client.query(
    'SELECT id FROM contacts WHERE tenant_id = $1 AND id = $2 FOR KEY SHARE',
    [input.tenantId, input.contactId],
  );
  if (!contact.rowCount) throw new ActivityReferenceError('CONTACT_NOT_FOUND');
  if (input.dealId) {
    const deal = await client.query(
      'SELECT id FROM deals WHERE tenant_id = $1 AND contact_id = $2 AND id = $3 FOR SHARE',
      [input.tenantId, input.contactId, input.dealId],
    );
    if (!deal.rowCount) throw new ActivityReferenceError('DEAL_NOT_FOUND');
  }
  const r = await client.query(
    `INSERT INTO activities (tenant_id, contact_id, deal_id, type, title, body, owner_id, due_at,
                             created_by_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      input.tenantId,
      input.contactId,
      input.dealId ?? null,
      input.type,
      input.title.trim(),
      input.body ?? null,
      input.ownerId ?? null,
      input.dueAt ?? null,
      // Quién la creó (#454). La tarea que anotó el asistente se revisa
      // distinto de la que anotó uno mismo, y en la tabla eran idénticas.
      input.actorKind ?? 'system',
    ],
  );
  await client.query(
    'UPDATE contacts SET last_activity_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2',
    [input.tenantId, input.contactId],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: input.actorKind ?? 'system',
    action: 'activity.created',
    resource: 'activity',
    resourceId: r.rows[0].id,
    result: 'ok',
    requestId: input.requestId,
    ip: input.ip,
    userAgent: input.userAgent,
    metadata: { contactId: input.contactId, dealId: input.dealId ?? null },
  });
  return rowToActivity(r.rows[0]);
}

export async function completeActivity(
  client: PoolClient,
  input: { tenantId: string; activityId: string },
): Promise<Activity> {
  const r = await client.query(
    `UPDATE activities SET done_at = COALESCE(done_at, now()), updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.activityId],
  );
  if (r.rowCount === 0) throw new Error('No encontramos esa actividad.');
  return rowToActivity(r.rows[0]);
}

export async function listActivitiesByContact(
  client: PoolClient,
  tenantId: string,
  contactId: string,
): Promise<Activity[]> {
  const r = await client.query(
    `SELECT * FROM activities WHERE tenant_id = $1 AND contact_id = $2
      ORDER BY (done_at IS NULL) DESC, due_at ASC NULLS LAST, created_at DESC`,
    [tenantId, contactId],
  );
  return r.rows.map(rowToActivity);
}

/**
 * Lo que hay que hacer, en todo el negocio (#454).
 *
 * Las actividades se creaban desde la ficha y desde el asistente, el
 * barrido las marcaba vencidas y publicaba el aviso… y no había forma de
 * verlas juntas: la única puerta era abrir la ficha del contacto exacto.
 * «¿Qué tengo que hacer hoy?» no tenía respuesta en el producto.
 *
 * El orden no es negociable: **lo vencido primero**. Una lista por fecha
 * de creación entierra lo atrasado debajo de lo que recién se anotó, que
 * es justo al revés de para qué se mira.
 *
 * `ownerId` filtra lo de una persona. Sin él, todo el equipo — pero eso lo
 * decide el permiso de quien pregunta, no esta función.
 */
export async function listActivities(
  client: PoolClient,
  input: {
    tenantId: string;
    ownerId?: string;
    /** También las que ya se hicieron. Por defecto NO: esto es una lista de pendientes. */
    incluirHechas?: boolean;
    limit?: number;
  },
): Promise<Array<Activity & { contactName: string | null; contactPhone: string | null }>> {
  const limite = Math.min(Math.max(1, Math.floor(input.limit ?? 100)), 200);
  const params: unknown[] = [input.tenantId];
  const where = ['a.tenant_id = $1'];
  if (input.ownerId) {
    params.push(input.ownerId);
    // Las sin dueño entran igual: una tarea de nadie es de todos, y
    // esconderla la deja sin hacer para siempre.
    where.push(`(a.owner_id = $${params.length} OR a.owner_id IS NULL)`);
  }
  if (!input.incluirHechas) where.push('a.done_at IS NULL');

  const r = await client.query(
    `SELECT a.*, k.name AS contact_name, k.phone AS contact_phone
       FROM activities a
       JOIN contacts k ON k.id = a.contact_id AND k.tenant_id = a.tenant_id
      WHERE ${where.join(' AND ')}
      ORDER BY
        -- Vencido primero, después lo que tiene fecha, y al final lo que no
        -- la tiene: una tarea sin fecha no es urgente, es un recordatorio.
        (a.done_at IS NULL AND a.due_at IS NOT NULL AND a.due_at < now()) DESC,
        (a.due_at IS NULL) ASC,
        a.due_at ASC,
        a.created_at DESC
      LIMIT ${limite}`,
    params,
  );
  return r.rows.map((row) => ({
    ...rowToActivity(row),
    contactName: (row.contact_name as string) ?? null,
    contactPhone: (row.contact_phone as string) ?? null,
  }));
}

/** Vencidas sin avisar → activity.due UNA vez. Lo llama el barrido de workers. */
export async function markDueActivities(
  client: PoolClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const r = await client.query(
    `UPDATE activities SET due_notified_at = $2, updated_at = now()
      WHERE tenant_id = $1 AND done_at IS NULL AND due_notified_at IS NULL
        AND due_at IS NOT NULL AND due_at < $2
      RETURNING id, contact_id, owner_id, title`,
    [tenantId, now],
  );
  for (const row of r.rows) {
    await publishEvent(client, {
      name: 'activity.due',
      tenantId,
      payload: { activityId: row.id, contactId: row.contact_id, ownerId: row.owner_id, title: row.title },
      actor: 'system',
    });
  }
  return r.rows.map((row) => row.id);
}

/** La ficha (#32): el contacto con sus oportunidades y actividades. */
export async function getContactFicha(
  client: PoolClient,
  tenantId: string,
  contactId: string,
): Promise<{
  contact: Record<string, unknown>;
  deals: Array<Record<string, unknown>>;
  activities: Activity[];
}> {
  // La empresa viaja con la ficha (#460): `contacts.company_id` existía
  // desde #217 y la ficha no lo proyectaba, así que la pantalla no podía
  // mostrar de qué empresa es alguien ni ofrecerse a cambiarlo.
  const contacto = await client.query(
    `SELECT c.id, c.phone, c.name, c.email, c.rut, c.origin, c.owner_id, c.custom,
            c.opt_in_at, c.opted_out_at, c.last_activity_at, c.created_at,
            c.company_id, e.name AS company_name
       FROM contacts c
       LEFT JOIN companies e ON e.id = c.company_id AND e.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, contactId],
  );
  if (contacto.rowCount === 0) throw new Error('No encontramos ese contacto. Puede que se haya eliminado.');
  const deals = await client.query(
    `SELECT d.id, d.title, d.status, d.value, d.currency, d.value_clp, d.stalled,
            d.created_at, s.name AS stage_name, p.name AS pipeline_name
       FROM deals d
       JOIN stages s ON s.id = d.stage_id
       JOIN pipelines p ON p.id = d.pipeline_id
      WHERE d.tenant_id = $1 AND d.contact_id = $2
      ORDER BY d.created_at DESC`,
    [tenantId, contactId],
  );
  const activities = await listActivitiesByContact(client, tenantId, contactId);
  return { contact: contacto.rows[0], deals: deals.rows, activities };
}
