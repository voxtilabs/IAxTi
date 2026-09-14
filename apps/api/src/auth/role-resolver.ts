import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { roleOf } from '@iaxti/module-identity';
import { customRolePermissions } from '@iaxti/module-authorization';
import { isPlatformAdmin } from '@iaxti/module-platform';

export type RoleResolver = (tenantId: string, userId: string) => Promise<string | null>;

const TTL_MS = 60_000;

/**
 * Rol del usuario en el tenant desde user_roles, con cache de 60 s por
 * request-path caliente. Cambiar el rol de alguien tarda a lo más un minuto
 * en notarse — aceptable y documentado.
 */
/** SUPERADMIN de plataforma desde platform_admins, con cache de 60 s. */
export function dbPlatformAdminResolver(pool: Pool): (userId: string) => Promise<boolean> {
  const cache = new Map<string, { admin: boolean; at: number }>();
  return async (userId) => {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.admin;
    const client = await pool.connect();
    try {
      const admin = await isPlatformAdmin(client, userId);
      cache.set(userId, { admin, at: Date.now() });
      return admin;
    } finally {
      client.release();
    }
  };
}

export function dbRoleResolver(pool: Pool): RoleResolver {
  const cache = new Map<string, { role: string | null; at: number }>();
  return async (tenantId, userId) => {
    const key = `${tenantId}:${userId}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.role;
    const role = await withTenant(pool, tenantId, (c) => roleOf(c, tenantId, userId));
    cache.set(key, { role, at: Date.now() });
    return role;
  };
}

/** Permisos de roles CUSTOM (#73) desde la base, con cache de 60 s. */
export function dbCustomPermissionsResolver(
  pool: Pool,
): (tenantId: string, roleName: string) => Promise<string[] | null> {
  const cache = new Map<string, { perms: string[] | null; at: number }>();
  return async (tenantId, roleName) => {
    const key = `${tenantId}:${roleName}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.perms;
    const perms = await withTenant(pool, tenantId, (c) =>
      customRolePermissions(c, tenantId, roleName),
    );
    cache.set(key, { perms, at: Date.now() });
    return perms;
  };
}
