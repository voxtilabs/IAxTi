import type { Pool, PoolClient } from 'pg';
import type { ModuleRegistry } from '@iaxti/core';

// Planes y módulos (#69, SPEC §22): los planes son configuración, no
// código. Los flags de módulos persisten en DB y el registry los aplica
// en caliente — el kill-switch sin desplegar.

export interface PlanRow {
  plan: string;
  priceClp: number | null;
  metaIncludedUsd: number | null;
  whatsappNumbers: number;
  conversationsMonth: number;
  iaExecutionsMonth: number;
  retentionMonths: number | null;
  apiRequestsMonth: number | null;
  modules: string[];
}

function rowToPlan(row: Record<string, unknown>): PlanRow {
  return {
    plan: row.plan as string,
    priceClp: row.price_clp === null ? null : Number(row.price_clp),
    metaIncludedUsd: row.meta_included_usd === null ? null : Number(row.meta_included_usd),
    whatsappNumbers: Number(row.whatsapp_numbers),
    conversationsMonth: Number(row.conversations_month),
    iaExecutionsMonth: Number(row.ia_executions_month),
    retentionMonths: row.retention_months === null ? null : Number(row.retention_months),
    apiRequestsMonth: row.api_requests_month === null ? null : Number(row.api_requests_month),
    modules: (row.modules as string[]) ?? [],
  };
}

async function platformAudit(
  client: Pick<Pool, 'query'>,
  adminUser: string,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO platform_audit (admin_user, action, metadata) VALUES ($1, $2, $3)`,
    [adminUser, action, JSON.stringify(metadata)],
  );
}

export async function listPlans(client: Pick<Pool, 'query'>): Promise<PlanRow[]> {
  const r = await client.query('SELECT * FROM plan_limits ORDER BY price_clp NULLS LAST');
  return r.rows.map(rowToPlan);
}

const CAMPOS_EDITABLES: Record<string, string> = {
  priceClp: 'price_clp',
  metaIncludedUsd: 'meta_included_usd',
  iaBudgetUsd: 'ia_budget_usd',
  whatsappNumbers: 'whatsapp_numbers',
  conversationsMonth: 'conversations_month',
  iaExecutionsMonth: 'ia_executions_month',
  retentionMonths: 'retention_months',
  apiRequestsMonth: 'api_requests_month',
};

/** Edita el plan SIN desplegar. Cada cambio queda en platform_audit. */
export async function updatePlan(
  client: Pick<Pool, 'query'>,
  input: {
    plan: string;
    changes: Partial<Record<keyof typeof CAMPOS_EDITABLES, number | null>> & { modules?: string[] };
    knownModules: string[];
    adminUser: string;
  },
): Promise<PlanRow> {
  const sets: string[] = [];
  const valores: unknown[] = [input.plan];
  for (const [campo, columna] of Object.entries(CAMPOS_EDITABLES)) {
    const valor = (input.changes as Record<string, unknown>)[campo];
    if (valor === undefined) continue;
    if (valor !== null && !(Number(valor) >= 0)) {
      throw new Error(`El valor de ${campo} no se entiende (número ≥ 0 o null).`);
    }
    valores.push(valor);
    sets.push(`${columna} = $${valores.length}`);
  }
  if (input.changes.modules !== undefined) {
    const fuera = input.changes.modules.filter((m) => !input.knownModules.includes(m));
    if (fuera.length > 0) {
      throw new Error(`Estos módulos no existen: ${fuera.join(', ')}.`);
    }
    valores.push(JSON.stringify(input.changes.modules));
    sets.push(`modules = $${valores.length}`);
  }
  if (sets.length === 0) throw new Error('No llegó ningún cambio.');
  const r = await client.query(
    `UPDATE plan_limits SET ${sets.join(', ')} WHERE plan = $1 RETURNING *`,
    valores,
  );
  if (r.rowCount === 0) throw new Error(`Plan desconocido: ${input.plan}.`);
  await platformAudit(client, input.adminUser, 'platform.plan.update', {
    plan: input.plan,
    changes: input.changes,
  });
  return rowToPlan(r.rows[0]);
}

export interface ModuleAdminRow {
  id: string;
  version: string;
  core: boolean;
  active: boolean;
  enabled: boolean;
  killSwitch: boolean;
  dependsOn: string[];
  /** Cuántos planes lo incluyen (proxy de "tenants que lo usan"). */
  tenantsUsing: number;
}

/** El estado de los módulos: registry vivo + tenants que los usan. */
export async function modulesAdmin(
  client: Pick<Pool, 'query'>,
  registry: ModuleRegistry,
): Promise<ModuleAdminRow[]> {
  const uso = await client.query(
    `SELECT m.module_id, count(DISTINCT t.id)::int AS tenants
       FROM plan_limits pl
       CROSS JOIN LATERAL jsonb_array_elements_text(pl.modules) AS m(module_id)
       JOIN tenants t ON t.plan = pl.plan AND t.state IN ('trial','active','past_due','read_only')
      GROUP BY m.module_id`,
  );
  const porModulo = new Map(uso.rows.map((r) => [r.module_id, Number(r.tenants)]));
  return registry.health().map((h) => ({
    ...h,
    tenantsUsing: porModulo.get(h.id) ?? 0,
  }));
}

/**
 * Cambia el flag de un módulo: el REGISTRY valida (dependencias, núcleo)
 * y si acepta, el flag PERSISTE — los demás procesos lo toman en su
 * próximo refresh (≤ 60 s), sin desplegar.
 */
export async function setModuleFlag(
  client: Pick<Pool, 'query'>,
  registry: ModuleRegistry,
  input: {
    moduleId: string;
    action: 'enable' | 'disable' | 'kill_on' | 'kill_off';
    adminUser: string;
  },
): Promise<ModuleAdminRow[]> {
  // La validación vive en el registry (regla 4 §26): lanza con voz clara.
  if (input.action === 'enable') registry.enable(input.moduleId);
  else if (input.action === 'disable') registry.disable(input.moduleId);
  else registry.killSwitch(input.moduleId, input.action === 'kill_on');

  const estado = registry.health().find((h) => h.id === input.moduleId);
  if (!estado) throw new Error(`Módulo desconocido: ${input.moduleId}.`);
  await client.query(
    `INSERT INTO platform_module_flags (module_id, enabled, kill_switch, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (module_id) DO UPDATE SET enabled = $2, kill_switch = $3, updated_by = $4, updated_at = now()`,
    [input.moduleId, estado.enabled, estado.killSwitch, input.adminUser],
  );
  await platformAudit(client, input.adminUser, 'platform.module.flag', {
    moduleId: input.moduleId,
    action: input.action,
  });
  return modulesAdmin(client, registry);
}

/**
 * El refresh en caliente: cada proceso lo llama al arrancar y cada 60 s
 * — los flags de la DB aplican SIN deploy. Los cambios que el registry
 * rechaza (dependencias) se ignoran con aviso al log.
 */
export async function applyModuleFlags(
  client: Pick<Pool, 'query'>,
  registry: ModuleRegistry,
): Promise<number> {
  const r = await client.query('SELECT module_id, enabled, kill_switch FROM platform_module_flags');
  let aplicados = 0;
  for (const fila of r.rows) {
    const estado = registry.health().find((h) => h.id === fila.module_id);
    if (!estado) continue;
    try {
      if (estado.killSwitch !== fila.kill_switch) {
        registry.killSwitch(fila.module_id, fila.kill_switch);
        aplicados += 1;
      }
      if (estado.enabled !== fila.enabled) {
        if (fila.enabled) registry.enable(fila.module_id);
        else registry.disable(fila.module_id);
        aplicados += 1;
      }
    } catch (err) {
      console.warn(`module-flags: ${fila.module_id} no se pudo aplicar: ${(err as Error).message}`);
    }
  }
  return aplicados;
}

/** Override de retención POR TENANT (#69) con el conteo de la próxima
 *  purga — el SuperAdmin ve exactamente qué borraría antes de tocar. */
export async function tenantRetentionPreview(
  client: PoolClient,
  tenantId: string,
): Promise<{ months: number | null; cutoff: Date | null; wouldPurge: number }> {
  const r = await client.query(
    `SELECT pl.retention_months,
            (t.settings->'retencion'->>'monthsOverride')::int AS override
       FROM tenants t LEFT JOIN plan_limits pl ON pl.plan = t.plan
      WHERE t.id = $1`,
    [tenantId],
  );
  if (r.rowCount === 0) throw new Error('No encontramos ese tenant.');
  const delPlan = r.rows[0].retention_months === null ? null : Number(r.rows[0].retention_months);
  const crudo = Number(r.rows[0].override);
  const override = Number.isFinite(crudo) && crudo > 0 ? crudo : null;
  const months =
    override !== null && (delPlan === null || override <= delPlan) ? override : delPlan;
  if (months === null) return { months: null, cutoff: null, wouldPurge: 0 };
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const n = await client.query(
    `SELECT count(*)::int AS n FROM conversations
      WHERE tenant_id = $1 AND state NOT IN ('new','open','snoozed') AND last_message_at < $2`,
    [tenantId, cutoff],
  );
  return { months, cutoff, wouldPurge: n.rows[0].n };
}

/** El override de retención con el sello del SuperAdmin (audit global). */
export async function setRetentionOverridePlatform(
  pool: Pool,
  input: { tenantId: string; months: number | null; adminUser: string },
): Promise<{ months: number | null; cutoff: Date | null; wouldPurge: number }> {
  if (input.months !== null) {
    if (!(Number(input.months) >= 1)) throw new Error('La retención mínima es de 1 mes.');
    const r = await pool.query(
      `SELECT pl.retention_months FROM tenants t
         LEFT JOIN plan_limits pl ON pl.plan = t.plan WHERE t.id = $1`,
      [input.tenantId],
    );
    if (r.rowCount === 0) throw new Error('No encontramos ese tenant.');
    const delPlan = r.rows[0].retention_months;
    if (delPlan !== null && Number(input.months) > Number(delPlan)) {
      throw new Error(`El plan retiene hasta ${delPlan} meses: el override no puede superarlo.`);
    }
  }
  await pool.query(
    `UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{retencion}',
       COALESCE(settings->'retencion', '{}'::jsonb) || jsonb_build_object('monthsOverride', $2::int))
      WHERE id = $1`,
    [input.tenantId, input.months],
  );
  await platformAudit(pool, input.adminUser, 'platform.tenant.retention_override', {
    tenantId: input.tenantId,
    months: input.months,
  });
  const client = await pool.connect();
  try {
    return await tenantRetentionPreview(client, input.tenantId);
  } finally {
    client.release();
  }
}
