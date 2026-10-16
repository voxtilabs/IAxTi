import type { PoolClient } from 'pg';

/** Requiere withAuthenticatedUser desde JWT. Una referencia no es membresía. */
export async function initialBusinessOf(client: PoolClient, userId: string): Promise<string | null> {
  const result = await client.query('SELECT tenant_id FROM initial_business_registrations WHERE user_id = $1', [userId]);
  return result.rows[0]?.tenant_id as string | undefined ?? null;
}

/** Solo durante el alta, con contexto de usuario Y tenant en la misma tx. */
export async function recordInitialBusiness(client: PoolClient, userId: string, tenantId: string): Promise<void> {
  await client.query('INSERT INTO initial_business_registrations(user_id, tenant_id) VALUES($1, $2)', [userId, tenantId]);
}
