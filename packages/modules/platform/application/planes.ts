import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';
import { editarLimitesDelPlan, guardarRetencionTenant, leerRetencionTenant, type CambiosDelPlan } from '@iaxti/module-organizations';
import type { ModuleRegistry } from '@iaxti/core';
import { quienesSonEnLaPlataforma, quienFue, type Quien } from '@iaxti/module-identity';

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

/**
 * El libro del SuperAdmin. Se exporta (#496) porque el panel del Agente
 * General audita con el MISMO libro: dos INSERT iguales en dos archivos es
 * como una de las dos copias se queda sin una columna.
 */
export async function platformAudit(
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

/** La plataforma abre la transacción y organizations valida/escribe sus límites. */
export async function updatePlan(
  pool: Pool,
  input: { plan: string; changes: CambiosDelPlan; knownModules: string[]; adminUser: string },
): Promise<PlanRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await editarLimitesDelPlan(client, {
      ...input, actor: input.adminUser,
      auditar: async (c, cambio) => platformAudit(c, cambio.actor, 'platform.plan.update', {
        plan: cambio.plan, changes: cambio.changes,
      }),
    });
    await client.query('COMMIT');
    return rowToPlan(row);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
  /**
   * Qué SuperAdmin tocó el flag, y cuándo (#697).
   *
   * `platform_module_flags.updated_by` se escribía en cada cambio y la tabla del
   * panel no lo mostraba. Apagar un módulo deja a negocios sin una función: con
   * varias personas en la plataforma, «esto estaba prendido ayer» necesita una
   * respuesta en la misma pantalla donde está el interruptor.
   *
   * `null` cuando el flag nunca se tocó a mano: lo que se ve es el registry.
   */
  tocadoPor: Quien | null;
  tocadoEl: Date | null;
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
  const flags = await client.query(
    'SELECT module_id, updated_by, updated_at FROM platform_module_flags',
  );
  const quien = await quienesSonEnLaPlataforma(client, flags.rows.map((f) => f.updated_by as string | null));
  const porFlag = new Map(flags.rows.map((f) => [f.module_id as string, f]));
  return registry.health().map((h) => {
    const flag = porFlag.get(h.id);
    return {
      ...h,
      tenantsUsing: porModulo.get(h.id) ?? 0,
      tocadoPor: flag ? quienFue(quien, flag.updated_by) : null,
      tocadoEl: (flag?.updated_at as Date) ?? null,
    };
  });
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
  const retencion = await leerRetencionTenant(client, tenantId);
  if (!retencion) throw new Error('No encontramos ese tenant.');
  const { months } = retencion;
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
  return withTenant(pool, input.tenantId, async (client) => {
    await guardarRetencionTenant(client, {
      tenantId: input.tenantId, monthsOverride: input.months,
      auditoria: {
        actor: input.adminUser, actorKind: 'superadmin',
        registrar: async (c, entrada) => {
          await writeAudit(c, entrada);
          await platformAudit(c, entrada.actor, 'platform.tenant.retention_override', {
            tenantId: input.tenantId, months: input.months,
          });
        },
      },
    });
    return tenantRetentionPreview(client, input.tenantId);
  });
}
