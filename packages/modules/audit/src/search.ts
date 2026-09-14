import type { PoolClient } from 'pg';
import type { ActorKind } from './write';

export interface AuditFilter {
  actor?: string;
  actorKind?: ActorKind;
  action?: string;
  resource?: string;
  /** Desde dónde se hizo: es la mitad de las preguntas de un auditor. */
  ip?: string;
  result?: string;
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
  if (filter.ip) add('host(ip) = ?', filter.ip);
  if (filter.result) add('result = ?', filter.result);
  if (filter.from) add('occurred_at >= ?', filter.from);
  if (filter.to) add('occurred_at <= ?', filter.to);
  params.push(Math.min(filter.limit ?? 50, 100));

  const sql = `
    SELECT id, tenant_id, actor, actor_kind, action, resource, resource_id,
           occurred_at, result, host(ip) AS ip, request_id, metadata
      FROM audit_log
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length}`;
  const result = await client.query(sql, params);
  return result.rows;
}


/**
 * La misma búsqueda, para el SuperAdmin (#72): cruza tenants a propósito, así
 * que corre con el pool de servicio —sin RLS— y exige el permiso
 * `platform.audit`. El filtro por tenant es opcional; sin él, se ve todo.
 */
export async function searchAuditGlobal(
  client: PoolClient,
  filter: AuditFilter & { tenantId?: string } = {},
) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };

  if (filter.tenantId) add('tenant_id = ?', filter.tenantId);
  if (filter.actor) add('actor = ?', filter.actor);
  if (filter.actorKind) add('actor_kind = ?', filter.actorKind);
  if (filter.action) add('action = ?', filter.action);
  if (filter.resource) add('resource = ?', filter.resource);
  if (filter.ip) add('host(ip) = ?', filter.ip);
  if (filter.result) add('result = ?', filter.result);
  if (filter.from) add('occurred_at >= ?', filter.from);
  if (filter.to) add('occurred_at <= ?', filter.to);
  // El tope es más alto que el del tenant porque un export de auditoría sin
  // filas suficientes no le sirve a nadie, pero sigue siendo un tope.
  params.push(Math.min(filter.limit ?? 100, 1000));

  const sql = `
    SELECT id, tenant_id, actor, actor_kind, action, resource, resource_id,
           occurred_at, result, host(ip) AS ip, request_id, metadata
      FROM audit_log
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length}`;
  const result = await client.query(sql, params);
  return result.rows;
}
