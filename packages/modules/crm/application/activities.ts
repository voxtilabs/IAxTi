import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';

// Actividades del CRM (#32, SPEC §10): llamada, reunión, tarea o nota.
// El aviso de vencida se publica una sola vez por el barrido programado.

export type ActivityType = 'llamada' | 'reunion' | 'tarea' | 'nota';

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
  },
): Promise<Activity> {
  if (!input.title?.trim()) throw new Error('La actividad necesita un título.');
  const r = await client.query(
    `INSERT INTO activities (tenant_id, contact_id, deal_id, type, title, body, owner_id, due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      input.tenantId,
      input.contactId,
      input.dealId ?? null,
      input.type,
      input.title.trim(),
      input.body ?? null,
      input.ownerId ?? null,
      input.dueAt ?? null,
    ],
  );
  await client.query(
    'UPDATE contacts SET last_activity_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2',
    [input.tenantId, input.contactId],
  );
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
  const contacto = await client.query(
    `SELECT id, phone, name, email, rut, origin, owner_id, custom,
            opt_in_at, opted_out_at, last_activity_at, created_at
       FROM contacts WHERE tenant_id = $1 AND id = $2`,
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
