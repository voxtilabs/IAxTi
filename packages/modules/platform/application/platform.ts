import type { PoolClient } from 'pg';

export interface TenantSummary {
  id: string;
  name: string;
  rubro: string | null;
  plan: string;
  state: string;
  createdAt: Date;
  /** El cargo mensual por ampliación de IA contratada, en pesos (#536). */
  iaAmpliacionClp: number | null;
}

/**
 * Lista cross-tenant para el SuperAdmin (SPEC §22, lectura). Corre con la
 * conexión de servicio; la autorización (platform.tenants) la impone el
 * guard antes de llegar aquí.
 */
export async function listTenants(client: PoolClient): Promise<TenantSummary[]> {
  const result = await client.query(
    // La ampliación de IA viaja en la lista (#536): el panel necesita mostrar
    // el valor actual para poder editarlo, y un campo que solo se puede escribir
    // a ciegas es cómo alguien pisa un cargo que ya estaba.
    `SELECT id, name, rubro, plan, state, created_at,
            settings->'billing'->>'iaAmpliacionClp' AS ia_ampliacion_clp
       FROM tenants ORDER BY created_at DESC LIMIT 100`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    rubro: row.rubro,
    plan: row.plan,
    state: row.state,
    createdAt: row.created_at,
    iaAmpliacionClp: row.ia_ampliacion_clp === null ? null : Number(row.ia_ampliacion_clp),
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
