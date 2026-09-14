import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { writeAudit } from '@iaxti/module-audit';
import { BASE_ROLES, baseRoleHasPermission, isBaseRole } from '../domain/base-roles';

// Roles personalizados (#73): con clientes reales aparecen "recepcionista",
// "contador" y "socio". Un custom CLONA un base y edita permisos del
// catálogo; los cuatro base siguen inmutables.

export interface Role {
  id: string;
  name: string;
  base: boolean;
  clonedFrom: string | null;
  permissions: string[];
}

function rowToRole(row: Record<string, unknown>, catalog?: ReadonlySet<string>): Role {
  const base = row.base as boolean;
  const name = row.name as string;
  return {
    id: row.id as string,
    name,
    base,
    clonedFrom: (row.cloned_from as string) ?? null,
    // Los base no guardan permisos: se CALCULAN del traductor sobre el
    // catálogo vigente (un módulo nuevo les llega solo).
    permissions:
      base && catalog && isBaseRole(name)
        ? [...catalog].filter((p) => baseRoleHasPermission(name, p, catalog)).sort()
        : ((row.permissions as string[]) ?? []),
  };
}

export async function listRoles(
  client: PoolClient,
  tenantId: string,
  catalog: ReadonlySet<string>,
): Promise<Role[]> {
  const r = await client.query(
    `SELECT * FROM roles WHERE tenant_id IS NULL OR tenant_id = $1
      ORDER BY base DESC, created_at`,
    [tenantId],
  );
  return r.rows
    .filter((row) => row.name !== 'SUPERADMIN') // el de plataforma no se toca ni se asigna
    .map((row) => rowToRole(row, catalog));
}

export async function createCustomRole(
  client: PoolClient,
  input: {
    tenantId: string;
    name: string;
    cloneFrom: string;
    catalog: ReadonlySet<string>;
    actor: string;
    requestId?: string;
  },
): Promise<Role> {
  const name = input.name?.trim();
  if (!name) throw new Error('El rol necesita un nombre.');
  if (isBaseRole(name.toUpperCase())) throw new Error('Ese nombre es de un rol base.');
  const desde = input.cloneFrom;
  if (!isBaseRole(desde) || desde === 'SUPERADMIN') {
    throw new Error(`Se clona desde un rol base: ${BASE_ROLES.filter((b) => b !== 'SUPERADMIN').join(', ')}.`);
  }
  const permisos = [...input.catalog]
    .filter((p) => baseRoleHasPermission(desde, p, input.catalog))
    .sort();
  const r = await client.query(
    `INSERT INTO roles (tenant_id, name, base, permissions, cloned_from)
     VALUES ($1, $2, false, $3, $4) RETURNING *`,
    [input.tenantId, name, JSON.stringify(permisos), input.cloneFrom],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'authorization.role.create',
    resource: 'role',
    resourceId: r.rows[0].id,
    result: 'ok',
    metadata: { name, cloneFrom: input.cloneFrom },
    requestId: input.requestId,
  });
  await publishEvent(client, {
    name: 'role.created',
    tenantId: input.tenantId,
    payload: { roleId: r.rows[0].id, name, cloneFrom: input.cloneFrom },
    actor: input.actor,
    requestId: input.requestId,
  });
  return rowToRole(r.rows[0]);
}

/** Solo los custom se editan; los permisos son SUBCONJUNTO del catálogo
 *  y los de plataforma jamás entran. */
export async function updateCustomRolePermissions(
  client: PoolClient,
  input: {
    tenantId: string;
    roleId: string;
    permissions: string[];
    catalog: ReadonlySet<string>;
    actor: string;
    requestId?: string;
  },
): Promise<Role> {
  const fuera = input.permissions.filter((p) => !input.catalog.has(p));
  if (fuera.length > 0) throw new Error(`Estos permisos no existen: ${fuera.join(', ')}.`);
  if (input.permissions.some((p) => p.startsWith('platform.'))) {
    throw new Error('Los permisos de plataforma no van en roles de tenant.');
  }
  const r = await client.query(
    `UPDATE roles SET permissions = $3
      WHERE id = $2 AND tenant_id = $1 AND base = false RETURNING *`,
    [input.tenantId, input.roleId, JSON.stringify([...new Set(input.permissions)].sort())],
  );
  if (r.rowCount === 0) throw new Error('Ese rol no existe o es base (los base son inmutables).');
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'authorization.role.update',
    resource: 'role',
    resourceId: input.roleId,
    result: 'ok',
    metadata: { permissions: input.permissions.length },
    requestId: input.requestId,
  });
  return rowToRole(r.rows[0]);
}

/** Un usuario tiene UN rol por tenant (SPEC §9); asignar exige
 *  roles.manage en el guard y queda en audit + evento. */
export async function assignRole(
  client: PoolClient,
  input: { tenantId: string; userId: string; roleId: string; actor: string; requestId?: string },
): Promise<void> {
  const rol = await client.query(
    `SELECT id, name FROM roles
      WHERE id = $2 AND (tenant_id = $1 OR (tenant_id IS NULL AND base AND name <> 'SUPERADMIN'))`,
    [input.tenantId, input.roleId],
  );
  if (rol.rowCount === 0) throw new Error('Ese rol no existe para este negocio.');
  const r = await client.query(
    `UPDATE user_roles SET role_id = $3 WHERE tenant_id = $1 AND user_id = $2`,
    [input.tenantId, input.userId, input.roleId],
  );
  if (r.rowCount === 0) throw new Error('Esa persona no es parte del equipo todavía.');
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'authorization.role.assign',
    resource: 'user',
    resourceId: input.userId,
    result: 'ok',
    metadata: { roleId: input.roleId, roleName: rol.rows[0].name },
    requestId: input.requestId,
  });
  await publishEvent(client, {
    name: 'role.assigned',
    tenantId: input.tenantId,
    payload: { userId: input.userId, roleId: input.roleId, roleName: rol.rows[0].name },
    actor: input.actor,
    requestId: input.requestId,
  });
}

/** Los permisos de un rol CUSTOM por nombre (para el guard). null = no
 *  existe como custom en ese tenant. */
export async function customRolePermissions(
  client: PoolClient,
  tenantId: string,
  roleName: string,
): Promise<string[] | null> {
  const r = await client.query(
    `SELECT permissions FROM roles WHERE tenant_id = $1 AND name = $2 AND base = false`,
    [tenantId, roleName],
  );
  return r.rowCount === 0 ? null : ((r.rows[0].permissions as string[]) ?? []);
}
