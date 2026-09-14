import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { checkConversationAlerts } from '@iaxti/module-conversations';

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
