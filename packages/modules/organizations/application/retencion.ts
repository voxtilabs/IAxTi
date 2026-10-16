import type { Pool, PoolClient } from 'pg';
import { auditarCambioTenant, exigirContextoTenant, type AuditoriaTenant } from './cambios-auditados';

/** Única forma persistida de tenants.settings.retencion (SPEC §39). */
interface RetencionTenant {
  monthsOverride?: number | null;
  firstPurgeAfter?: string;
}

export interface RetencionVigente {
  months: number | null;
  firstPurgeAfter: Date | null;
}

function interpretar(retencion: RetencionTenant | null, delPlan: number | null): RetencionVigente {
  const override = retencion?.monthsOverride;
  const months = typeof override === 'number' && Number.isInteger(override) && override > 0 &&
    (delPlan === null || override <= delPlan) ? override : delPlan;
  const fecha = retencion?.firstPurgeAfter ? new Date(retencion.firstPurgeAfter) : null;
  return { months, firstPurgeAfter: fecha && Number.isFinite(fecha.getTime()) ? fecha : null };
}

export async function leerRetencionTenant(client: PoolClient, tenantId: string): Promise<RetencionVigente | null> {
  const r = await client.query(
    `SELECT pl.retention_months, t.settings->'retencion' AS retencion
       FROM tenants t LEFT JOIN plan_limits pl ON pl.plan = t.plan WHERE t.id = $1`, [tenantId],
  );
  if (!r.rowCount) return null;
  return interpretar(r.rows[0].retencion, r.rows[0].retention_months);
}

/** Cambia solo la parte solicitada; null en firstPurgeAfter elimina una marca ya vencida. */
export async function guardarRetencionTenant(
  client: PoolClient,
  input: {
    tenantId: string; monthsOverride?: number | null; firstPurgeAfter?: Date | null;
    auditoria: AuditoriaTenant; now?: Date;
  },
): Promise<void> {
  await exigirContextoTenant(client, input.tenantId);
  const r = await client.query(
    `SELECT t.settings, pl.retention_months FROM tenants t
       LEFT JOIN plan_limits pl ON pl.plan = t.plan WHERE t.id = $1 FOR UPDATE OF t`, [input.tenantId],
  );
  if (!r.rowCount) throw new Error('No encontramos ese tenant.');
  const settings = r.rows[0].settings as Record<string, unknown>;
  const retencion = { ...((settings.retencion ?? {}) as RetencionTenant) };
  const cambios: Record<string, unknown> = {};
  if (input.monthsOverride !== undefined) {
    const months = input.monthsOverride;
    if (months !== null && (!Number.isInteger(months) || months < 1)) {
      throw new Error('La retención mínima es de 1 mes, en meses enteros.');
    }
    const delPlan = r.rows[0].retention_months as number | null;
    if (months !== null && delPlan !== null && months > delPlan) {
      throw new Error(`El plan retiene hasta ${delPlan} meses: el override no puede superarlo.`);
    }
    retencion.monthsOverride = months;
    cambios.monthsOverride = months;
  }
  if (input.firstPurgeAfter !== undefined) {
    if (input.firstPurgeAfter === null) {
      // Una purga que termina tarde no debe quitar un aviso nuevo todavía vigente.
      const fecha = retencion.firstPurgeAfter ? new Date(retencion.firstPurgeAfter) : null;
      if (fecha && fecha <= (input.now ?? new Date())) {
        delete retencion.firstPurgeAfter;
        cambios.firstPurgeAfter = null;
      }
    } else {
      if (!Number.isFinite(input.firstPurgeAfter.getTime())) throw new Error('La fecha de la purga no se entiende.');
      retencion.firstPurgeAfter = input.firstPurgeAfter.toISOString();
      cambios.firstPurgeAfter = retencion.firstPurgeAfter;
    }
  }
  if (!Object.keys(cambios).length) return;
  await client.query(
    `UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{retencion}', $2::jsonb)
      WHERE id = $1`, [input.tenantId, JSON.stringify(retencion)],
  );
  await auditarCambioTenant(client, input.tenantId, input.auditoria, 'tenant.retention.updated', cambios);
}

export async function tenantsConRetencion(pool: Pick<Pool, 'query'>): Promise<string[]> {
  const r = await pool.query(
    `SELECT t.id FROM tenants t LEFT JOIN plan_limits pl ON pl.plan = t.plan
      WHERE t.state = 'active'
        AND (pl.retention_months IS NOT NULL OR (t.settings->'retencion'->>'monthsOverride') IS NOT NULL)`,
  );
  return r.rows.map((x) => x.id as string);
}
