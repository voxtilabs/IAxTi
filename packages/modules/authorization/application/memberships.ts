import type { PoolClient } from 'pg';
import { ModuleRegistry } from '@iaxti/core';
import { writeAudit } from '@iaxti/module-audit';
import { baseRoleHasPermission, isBaseRole } from '../domain/base-roles';

let catalog: ReadonlySet<string> | undefined;
function permissionsCatalog(): ReadonlySet<string> {
  return catalog ??= new Set(new ModuleRegistry().load().permissionsCatalog().keys());
}

export interface TeamMembership {
  userId: string;
  roleName: string;
  joinedAt: Date;
}

/** Lecturas de pertenencia dentro del tenant; RLS sigue siendo la segunda cerradura. */
export async function teamMemberships(
  client: PoolClient, tenantId: string, userIds?: readonly string[],
): Promise<TeamMembership[]> {
  const result = await client.query(
    `SELECT ur.user_id, r.name, ur.created_at
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.tenant_id = $1 AND ($2::uuid[] IS NULL OR ur.user_id = ANY($2))
      ORDER BY ur.created_at, ur.user_id`,
    [tenantId, userIds ?? null],
  );
  return result.rows.map((row) => ({
    userId: row.user_id as string, roleName: row.name as string, joinedAt: row.created_at as Date,
  }));
}

/** El mismo traductor que el guard: catálogo vigente, roles base y permisos custom. */
export async function usersWithPermission(
  client: PoolClient, tenantId: string, permission: string,
): Promise<string[]> {
  const known = permissionsCatalog();
  if (!known.has(permission)) return [];
  const result = await client.query(
    `SELECT ur.user_id, r.name, r.base, r.permissions
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.tenant_id = $1 ORDER BY ur.user_id`,
    [tenantId],
  );
  return result.rows.filter((row) => row.base
    ? isBaseRole(row.name) && baseRoleHasPermission(row.name, permission, known)
    : !permission.startsWith('platform.') && (row.permissions as string[]).includes(permission),
  ).map((row) => row.user_id as string);
}

/** Antes de elegir negocio: el caller fija app.user_id desde la sesión autenticada.
 * Sin ese contexto RLS no concede lectura cross-tenant. Nunca se acepta desde un DTO. */
export async function membershipsOf(
  client: PoolClient, userId: string,
): Promise<Array<{ tenantId: string; roleName: string }>> {
  const result = await client.query(
    `SELECT ur.tenant_id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 ORDER BY ur.tenant_id`,
    [userId],
  );
  return result.rows.map((row) => ({ tenantId: row.tenant_id as string, roleName: row.name as string }));
}

/** Revocar acceso conserva la regla del último administrador, incluso para roles propios. */
export async function removeMembership(
  client: PoolClient,
  input: { tenantId: string; userId: string; actor: string },
): Promise<void> {
  if (input.userId === input.actor) {
    throw new Error('No puedes quitarte a ti mismo: pídeselo a otra persona que administre.');
  }
  // Compartido con assignRole: dos cambios concurrentes no pueden quitar a ambos administradores.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('authorization.memberships'), hashtext($1))", [input.tenantId]);
  const result = await client.query('DELETE FROM user_roles WHERE tenant_id = $1 AND user_id = $2 RETURNING user_id',
    [input.tenantId, input.userId]);
  if (!result.rowCount) throw new Error('Esa persona no está en este negocio.');
  if ((await usersWithPermission(client, input.tenantId, 'roles.manage')).length === 0) {
    throw new Error('Es la única persona que administra el negocio: nombra a otra antes de quitarla.');
  }
  await writeAudit(client, {
    tenantId: input.tenantId, actor: input.actor, actorKind: 'user',
    action: 'authorization.membership.remove', resource: 'user', resourceId: input.userId, result: 'ok',
  });
}
