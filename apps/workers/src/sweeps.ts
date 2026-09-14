import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import { withTenant } from '@iaxti/db';
import {
  archiveTenant,
  autoResolveTenant,
  checkConversationAlerts,
} from '@iaxti/module-conversations';
import { markDueActivities } from '@iaxti/module-crm';

/**
 * El barrido de avisos de la bandeja (#38): recorre los tenants operativos y
 * corre las alertas de cada uno bajo su contexto. Lo dispara el job
 * repetible `conversations.checks` de la cola `scheduled` (cada minuto).
 */
export async function sweepConversationAlerts(
  pool: Pool,
): Promise<{ tenants: number; unattended: number; breached: number }> {
  const tenants = await pool.query(
    `SELECT id FROM tenants WHERE COALESCE(state, 'active') IN ('trial','active','past_due')`,
  );
  let unattended = 0;
  let breached = 0;
  for (const row of tenants.rows) {
    const res = await withTenant(pool, row.id, (client) =>
      checkConversationAlerts(client, row.id),
    );
    unattended += res.unattended.length;
    breached += res.breached.length;
  }
  return { tenants: tenants.rowCount ?? 0, unattended, breached };
}

async function tenantIds(pool: Pool): Promise<string[]> {
  const r = await pool.query(
    `SELECT id FROM tenants WHERE COALESCE(state, 'active') IN ('trial','active','past_due')`,
  );
  return r.rows.map((row) => row.id);
}

/**
 * Patrón §39: el job PADRE recorre tenants y encola un job HIJO por cada
 * uno — un tenant grande no bloquea a los demás y los reintentos son por
 * tenant. `job` es 'conversations.auto_resolve' o 'conversations.archive'.
 */
export async function enqueueTenantChildren(
  pool: Pool,
  queue: Queue,
  job: 'conversations.auto_resolve' | 'conversations.archive',
): Promise<number> {
  const ids = await tenantIds(pool);
  for (const tenantId of ids) {
    await queue.add(`${job}.tenant`, { moduleId: 'conversations', tenantId });
  }
  return ids.length;
}

export async function runAutoResolveTenant(pool: Pool, tenantId: string) {
  const res = await withTenant(pool, tenantId, (c) => autoResolveTenant(c, tenantId));
  if (res.count > 0) console.log(`auto_resolve: ${res.count} cerradas en ${tenantId}`);
  return { tenantId, resolved: res.count };
}

export async function runArchiveTenant(pool: Pool, tenantId: string) {
  const res = await withTenant(pool, tenantId, (c) => archiveTenant(c, tenantId));
  if (res.count > 0) console.log(`archive: ${res.count} archivadas en ${tenantId}`);
  return { tenantId, archived: res.count };
}

/** Actividades vencidas (#32): activity.due una vez, por tenant operativo. */
export async function sweepDueActivities(pool: Pool): Promise<{ tenants: number; due: number }> {
  const ids = await tenantIds(pool);
  let due = 0;
  for (const tenantId of ids) {
    const res = await withTenant(pool, tenantId, (c) => markDueActivities(c, tenantId));
    due += res.length;
  }
  return { tenants: ids.length, due };
}
