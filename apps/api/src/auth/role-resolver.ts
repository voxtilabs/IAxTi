import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { roleOf } from '@iaxti/module-identity';

export type RoleResolver = (tenantId: string, userId: string) => Promise<string | null>;

const TTL_MS = 60_000;

/**
 * Rol del usuario en el tenant desde user_roles, con cache de 60 s por
 * request-path caliente. Cambiar el rol de alguien tarda a lo más un minuto
 * en notarse — aceptable y documentado.
 */
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
