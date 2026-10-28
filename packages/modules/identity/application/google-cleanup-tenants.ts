import type { Pool } from 'pg';
/** Solo IDs con trabajo; nunca expone grants ni referencias fuera de su tenant. */
export async function tenantsConLimpiezaGoogle(pool: Pick<Pool,'query'>): Promise<string[]> {
  const result=await pool.query<{tenant_id:string}>('SELECT tenant_id FROM tenants_con_limpieza_google()');
  return result.rows.map(row=>row.tenant_id);
}
