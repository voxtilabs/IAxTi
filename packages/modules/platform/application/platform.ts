import type { PoolClient } from 'pg';

export interface TenantSummary {
  id: string;
  name: string;
  rubro: string | null;
  plan: string;
  state: string;
  createdAt: Date;
}

/**
 * Lista cross-tenant para el SuperAdmin (SPEC §22, lectura). Corre con la
 * conexión de servicio; la autorización (platform.tenants) la impone el
 * guard antes de llegar aquí.
 */
export async function listTenants(client: PoolClient): Promise<TenantSummary[]> {
  const result = await client.query(
    `SELECT id, name, rubro, plan, state, created_at
       FROM tenants ORDER BY created_at DESC LIMIT 100`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    rubro: row.rubro,
    plan: row.plan,
    state: row.state,
    createdAt: row.created_at,
  }));
}

/** ¿El usuario es administrador de plataforma? (rol SUPERADMIN efectivo) */
export async function isPlatformAdmin(client: PoolClient, userId: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM platform_admins WHERE user_id = $1', [userId]);
  return (result.rowCount ?? 0) > 0;
}

export async function grantPlatformAdmin(client: PoolClient, userId: string): Promise<void> {
  await client.query(
    'INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [userId],
  );
}
