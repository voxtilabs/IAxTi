import type { PoolClient } from 'pg';
import type { ActorKind } from './write';

export interface AuditFilter {
  actor?: string;
  actorKind?: ActorKind;
  action?: string;
  resource?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

/** Búsqueda dentro del tenant en contexto (RLS acota; permiso audit.read). */
export async function searchAudit(client: PoolClient, filter: AuditFilter = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };

  if (filter.actor) add('actor = ?', filter.actor);
  if (filter.actorKind) add('actor_kind = ?', filter.actorKind);
  if (filter.action) add('action = ?', filter.action);
  if (filter.resource) add('resource = ?', filter.resource);
  if (filter.from) add('occurred_at >= ?', filter.from);
  if (filter.to) add('occurred_at <= ?', filter.to);
  params.push(Math.min(filter.limit ?? 50, 100));

  const sql = `
    SELECT id, actor, actor_kind, action, resource, resource_id,
           occurred_at, result, request_id, metadata
      FROM audit_log
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length}`;
  const result = await client.query(sql, params);
  return result.rows;
}
