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
