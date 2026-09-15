import { publishEvent } from '@iaxti/core';
import type { PoolClient } from 'pg';

// Ajustes del tenant (tenants.settings jsonb, SPEC §39): cada módulo guarda
// su rincón bajo una clave propia (bandeja, retencion, …) y valida su forma.

export async function getTenantSettings(
  client: PoolClient,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const r = await client.query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  if (r.rowCount === 0) throw new Error('No encontramos ese negocio.');
  return (r.rows[0].settings as Record<string, unknown>) ?? {};
}

/** Merge superficial por clave de módulo: `patch` reemplaza esa clave entera. */
export async function updateTenantSettings(
  client: PoolClient,
  tenantId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await client.query(
    `UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1 RETURNING settings`,
    [tenantId, JSON.stringify(patch)],
  );
  if (r.rowCount === 0) throw new Error('No encontramos ese negocio.');
  // Que el negocio configure sus ajustes es el primer paso del onboarding
  // (SPEC §7) y hasta ahora no lo contaba nadie.
  await publishEvent(client, {
    name: 'tenant.settings_changed',
    tenantId,
    payload: { claves: Object.keys(patch) },
    actor: 'system',
  });
  return r.rows[0].settings as Record<string, unknown>;
}
