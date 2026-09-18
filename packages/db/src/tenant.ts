import type { Pool, PoolClient } from 'pg';

/**
 * Cerrojo 2 del multi-tenancy (SPEC §27): ejecuta `fn` dentro de una
 * transacción con `app.tenant_id` fijado para la transacción; las políticas
 * RLS lo leen con `current_setting('app.tenant_id', true)`. Fuera de este
 * wrapper, las tablas con RLS forzado no devuelven filas de negocio.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Los ids de tenants sobre los que un barrido tiene que trabajar (#286).
 *
 * Existe porque casi todos los barridos empezaban con una consulta suelta a
 * una tabla de negocio —`SELECT DISTINCT tenant_id FROM appointments ...`— y
 * eso no funciona con el rol de producción: una consulta fuera de
 * `withTenant` corre sin `app.tenant_id`, RLS evalúa `tenant_id = NULL` y
 * devuelve cero filas. En desarrollo no se notaba porque el rol es
 * superusuario y Postgres ni mira las políticas.
 *
 * `tenants` NO tiene RLS, a propósito: es el registro de quiénes existen y
 * es por donde un barrido debe empezar. Después se entra a cada uno con
 * `withTenant` y ahí sí se ve su trabajo.
 *
 * El precio es pasar de una consulta a N. Con la cantidad de tenants del
 * primer año no es un problema, y es lo que cuesta que el aislamiento sea
 * de verdad y no solo en desarrollo.
 */
export async function idsDeTenants(
  pool: Pool,
  opts: { estados?: readonly string[] } = {},
): Promise<string[]> {
  const estados = opts.estados ?? ['trial', 'active', 'past_due', 'read_only', 'suspended'];
  const r = await pool.query(
    `SELECT id FROM tenants WHERE COALESCE(state, 'active') = ANY($1) ORDER BY created_at`,
    [estados],
  );
  return r.rows.map((x) => x.id as string);
}

/**
 * Recorre los tenants y corre `fn` dentro del contexto de cada uno.
 *
 * Un tenant que falla no puede dejar sin barrer a los demás: se anota y se
 * sigue. Ese detalle importa más de lo que parece — el barrido que se cae en
 * el primer tenant deja a todos los demás sin servicio y solo se nota
 * mirando logs.
 */
export async function porCadaTenant<T>(
  pool: Pool,
  fn: (client: PoolClient, tenantId: string) => Promise<T>,
  opts: { estados?: readonly string[]; alFallar?: (tenantId: string, err: Error) => void } = {},
): Promise<T[]> {
  const salida: T[] = [];
  for (const tenantId of await idsDeTenants(pool, opts)) {
    try {
      salida.push(await withTenant(pool, tenantId, (c) => fn(c, tenantId)));
    } catch (err) {
      (opts.alFallar ?? ((t, e) => console.error(`barrido: ${t} falló — ${e.message}`)))(
        tenantId,
        err as Error,
      );
    }
  }
  return salida;
}
