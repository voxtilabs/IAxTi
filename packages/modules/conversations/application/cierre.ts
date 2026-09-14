import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { getTenantSettings } from '@iaxti/module-organizations';
import { writeAudit } from '@iaxti/module-audit';
import { cierreSettings } from '../domain/cierre';

// Cierre automático y archivo (#40, SPEC §39): inactividad significa cerrar,
// no borrar — el historial es el activo del CRM. Una entrada de audit por
// tenant y corrida (no por conversación: inflaría audit sin información).

export interface RunResult {
  count: number;
  ids: string[];
}

/**
 * open/pending sin actividad por N días pasa a resolved. La inactividad se
 * mide con last_message_at (cualquier dirección) y se exige que TAMPOCO
 * haya entrante fresco (last_inbound_at), como pide §39.
 */
export async function autoResolveTenant(
  client: PoolClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<RunResult> {
  const settings = cierreSettings(await getTenantSettings(client, tenantId));
  const r = await client.query(
    `UPDATE conversations SET state = 'resolved', updated_at = now()
      WHERE tenant_id = $1 AND state IN ('open','pending') AND archived_at IS NULL
        AND last_message_at < $3::timestamptz - make_interval(days => $2)
        AND (last_inbound_at IS NULL OR last_inbound_at < $3::timestamptz - make_interval(days => $2))
      RETURNING id`,
    [tenantId, settings.autoResolveDays, now],
  );
  const ids = r.rows.map((row) => row.id);
  for (const id of ids) {
    await publishEvent(client, {
      name: 'conversation.auto_resolved',
      tenantId,
      payload: { conversationId: id, afterDays: settings.autoResolveDays },
      actor: 'system',
    });
    await publishEvent(client, {
      name: 'conversation.state_changed',
      tenantId,
      payload: { conversationId: id, from: 'open', to: 'resolved', auto: true },
      actor: 'system',
    });
  }
  if (ids.length > 0) {
    await writeAudit(client, {
      tenantId,
      actor: 'system',
      actorKind: 'system',
      action: 'conversations.auto_resolve.run',
      resource: 'conversations',
      result: 'ok',
      metadata: { resolved: ids.length, afterDays: settings.autoResolveDays },
    });
  }
  return { count: ids.length, ids };
}

/**
 * resolved sin actividad por M meses recibe archived_at: sale de la bandeja
 * y sus filtros, sigue en búsqueda y en la ficha. null desactiva. Nada se
 * borra (la retención por plan es de Fase 5).
 */
export async function archiveTenant(
  client: PoolClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<RunResult> {
  const settings = cierreSettings(await getTenantSettings(client, tenantId));
  if (settings.archiveAfterMonths === null) return { count: 0, ids: [] };
  const r = await client.query(
    `UPDATE conversations SET archived_at = $3, updated_at = now()
      WHERE tenant_id = $1 AND state = 'resolved' AND archived_at IS NULL
        AND last_message_at < $3::timestamptz - make_interval(months => $2)
      RETURNING id`,
    [tenantId, settings.archiveAfterMonths, now],
  );
  const ids = r.rows.map((row) => row.id);
  for (const id of ids) {
    await publishEvent(client, {
      name: 'conversation.archived',
      tenantId,
      payload: { conversationId: id, afterMonths: settings.archiveAfterMonths },
      actor: 'system',
    });
  }
  if (ids.length > 0) {
    await writeAudit(client, {
      tenantId,
      actor: 'system',
      actorKind: 'system',
      action: 'conversations.archive.run',
      resource: 'conversations',
      result: 'ok',
      metadata: { archived: ids.length, afterMonths: settings.archiveAfterMonths },
    });
  }
  return { count: ids.length, ids };
}
