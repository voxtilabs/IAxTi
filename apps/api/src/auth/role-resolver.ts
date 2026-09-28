import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { roleOf } from '@iaxti/module-identity';
import { customRolePermissions } from '@iaxti/module-authorization';
import { isPlatformAdmin } from '@iaxti/module-platform';

export type RoleResolver = (tenantId: string, userId: string) => Promise<string | null>;

const TTL_MS = 60_000;

/**
 * Un tenant que no es uuid jamás va a calzar con una fila, y preguntarlo a la
 * base revienta la consulta (`invalid input syntax for type uuid`) — un 500
 * donde corresponde un 403. El id llega en una cabecera: basta con que alguien
 * mande cualquier cosa. Se corta antes de tocar la base.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function esTenantPlausible(tenantId: string): boolean {
  return UUID.test(tenantId);
}

/**
 * Rol del usuario en el tenant desde user_roles, con cache de 60 s por
 * request-path caliente. Cambiar el rol de alguien tarda a lo más un minuto
 * en notarse — aceptable y documentado.
 */

/**
 * Un cache que además junta las llamadas simultáneas (#673).
 *
 * Los tres resolutores cacheaban el RESULTADO, y eso deja un agujero: con el
 * cache frío, N llamadas concurrentes —del mismo usuario, pidiendo lo mismo—
 * fallan el cache a la vez y las N van a la base.
 *
 * Lo que costó, medido en Sentry: abrir el panel de SuperAdmin dispara siete
 * pedidos a la vez, cada uno toma una conexión para su guard y otra para su
 * trabajo, y el pool tiene seis. Siete errores en el mismo segundo, todos
 * «timeout exceeded when trying to connect».
 *
 * Guardando la PROMESA antes de esperarla, las otras seis se cuelgan de la
 * primera: una conexión, una consulta, siete respuestas.
 *
 * Si falla, la entrada se borra: un error cacheado sesenta segundos sería peor
 * que la estampida que vino a arreglar.
 */
function cacheQueJunta<T>(ttlMs: number, traer: (clave: string) => Promise<T>) {
  const cache = new Map<string, { valor: Promise<T>; at: number }>();
  return (clave: string): Promise<T> => {
    const hit = cache.get(clave);
    if (hit && Date.now() - hit.at < ttlMs) return hit.valor;
    const valor = traer(clave);
    cache.set(clave, { valor, at: Date.now() });
    void valor.catch(() => {
      // Solo si sigue siendo ESTA: si alguien ya puso una nueva, borrarla
      // perdería un resultado bueno.
      if (cache.get(clave)?.valor === valor) cache.delete(clave);
    });
    return valor;
  };
}

/** SUPERADMIN de plataforma desde platform_admins, con cache de 60 s. */
export function dbPlatformAdminResolver(pool: Pool): (userId: string) => Promise<boolean> {
  return cacheQueJunta(TTL_MS, async (userId) => {
    const client = await pool.connect();
    try {
      return await isPlatformAdmin(client, userId);
    } finally {
      client.release();
    }
  });
}

export function dbRoleResolver(pool: Pool): RoleResolver {
  const traer = cacheQueJunta(TTL_MS, (clave: string) => {
    const [tenantId, userId] = clave.split(':');
    return withTenant(pool, tenantId, (c) => roleOf(c, tenantId, userId));
  });
  return async (tenantId, userId) => {
    if (!esTenantPlausible(tenantId)) return null;
    return traer(`${tenantId}:${userId}`);
  };
}

/** Permisos de roles CUSTOM (#73) desde la base, con cache de 60 s. */
export function dbCustomPermissionsResolver(
  pool: Pool,
): (tenantId: string, roleName: string) => Promise<string[] | null> {
  const traer = cacheQueJunta(TTL_MS, (clave: string) => {
    const [tenantId, roleName] = clave.split(':');
    return withTenant(pool, tenantId, (c) => customRolePermissions(c, tenantId, roleName));
  });
  return async (tenantId, roleName) => {
    if (!esTenantPlausible(tenantId)) return null;
    return traer(`${tenantId}:${roleName}`);
  };
}
