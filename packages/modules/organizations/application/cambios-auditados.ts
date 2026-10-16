import type { PoolClient } from 'pg';
import { olvidarPlanes } from './plan-modulos';

/** Puerto obligatorio: audit depende de organizations, por eso se conecta desde el llamador. */
export interface AuditoriaTenant {
  actor: string;
  actorKind: 'user' | 'system' | 'superadmin';
  registrar: (client: PoolClient, entrada: {
    tenantId: string; actor: string; actorKind: 'user' | 'system' | 'superadmin';
    action: string; resource: string; resourceId: string; result: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
}

/** tenants es tabla de plataforma sin RLS: el contrato valida el contexto explícitamente. */
export async function exigirContextoTenant(client: PoolClient, tenantId: string): Promise<void> {
  const r = await client.query("SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant");
  if (r.rows[0]?.tenant !== tenantId) throw new Error('El contexto no corresponde a ese negocio.');
}

export async function auditarCambioTenant(
  client: PoolClient, tenantId: string, auditoria: AuditoriaTenant,
  action: string, metadata: Record<string, unknown>,
): Promise<void> {
  if (!auditoria.actor?.trim()) throw new Error('El cambio necesita identificar a quien lo solicita.');
  await auditoria.registrar(client, {
    tenantId, actor: auditoria.actor, actorKind: auditoria.actorKind,
    action, resource: 'tenant', resourceId: tenantId, result: 'ok', metadata,
  });
}

/** Marca y audita una sola vez, revalidando suspensión y antigüedad bajo lock. */
export async function marcarAvisoDeBorrado(
  client: PoolClient,
  input: { tenantId: string; diasMinimos: number; auditoria: AuditoriaTenant },
): Promise<{ dias: number; name: string } | null> {
  await exigirContextoTenant(client, input.tenantId);
  const actual = await client.query(
    `SELECT state, name, deletion_warned_at, EXTRACT(DAY FROM now() - state_since)::int AS dias
       FROM tenants WHERE id = $1 FOR UPDATE`, [input.tenantId],
  );
  const t = actual.rows[0];
  if (!t || t.state !== 'suspended' || t.deletion_warned_at || t.dias < input.diasMinimos) return null;
  await client.query('UPDATE tenants SET deletion_warned_at = now() WHERE id = $1', [input.tenantId]);
  await auditarCambioTenant(client, input.tenantId, input.auditoria, 'tenant.deletion_warned', {
    diasSuspendido: t.dias, name: t.name,
  });
  return { dias: t.dias, name: t.name };
}

/** La extensión administrativa mantiene el extremo posterior entre ahora y la fecha vigente. */
export async function extenderPrueba(
  client: PoolClient,
  input: { tenantId: string; days: number; auditoria: AuditoriaTenant },
): Promise<{ trialEndsAt: Date }> {
  await exigirContextoTenant(client, input.tenantId);
  if (input.auditoria.actorKind !== 'superadmin') throw new Error('Solo plataforma puede extender la prueba.');
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 90) {
    throw new Error('La extensión va de 1 a 90 días.');
  }
  const r = await client.query(
    `UPDATE tenants SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, now()), now()) + make_interval(days => $2)
      WHERE id = $1 RETURNING trial_ends_at`, [input.tenantId, input.days],
  );
  if (r.rowCount === 0) throw new Error('No encontramos ese tenant.');
  await auditarCambioTenant(client, input.tenantId, input.auditoria, 'tenant.trial_extended', { days: input.days });
  return { trialEndsAt: r.rows[0].trial_ends_at };
}

const CAMPOS_EDITABLES = {
  priceClp: 'price_clp', metaIncludedUsd: 'meta_included_usd', iaBudgetUsd: 'ia_budget_usd',
  whatsappNumbers: 'whatsapp_numbers', conversationsMonth: 'conversations_month',
  iaExecutionsMonth: 'ia_executions_month', retentionMonths: 'retention_months',
  apiRequestsMonth: 'api_requests_month',
} as const;
export type CambiosDelPlan = Partial<Record<keyof typeof CAMPOS_EDITABLES, number | null>> & { modules?: string[] };

/** Límites globales: el caller aporta su libro de plataforma, en ESTA transacción. */
export async function editarLimitesDelPlan(
  client: PoolClient,
  input: {
    plan: string; changes: CambiosDelPlan; knownModules: string[]; actor: string;
    auditar: (client: PoolClient, cambio: { actor: string; plan: string; changes: CambiosDelPlan }) => Promise<void>;
  },
): Promise<Record<string, unknown>> {
  if (!input.actor?.trim()) throw new Error('El cambio necesita identificar a quien lo solicita.');
  const sets: string[] = [];
  const valores: unknown[] = [input.plan];
  for (const [campo, columna] of Object.entries(CAMPOS_EDITABLES)) {
    const valor = (input.changes as Record<string, unknown>)[campo];
    if (valor === undefined) continue;
    const entero = ['whatsappNumbers', 'conversationsMonth', 'iaExecutionsMonth', 'retentionMonths', 'apiRequestsMonth'].includes(campo);
    const obligatorio = ['whatsappNumbers', 'conversationsMonth', 'iaExecutionsMonth'].includes(campo);
    if ((valor === null && obligatorio) || (valor !== null &&
      (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0 || (entero && !Number.isInteger(valor)) || (campo === 'retentionMonths' && valor < 1)))) {
      throw new Error(`El valor de ${campo} no se entiende (número válido o null si admite ilimitado).`);
    }
    valores.push(valor);
    sets.push(`${columna} = $${valores.length}`);
  }
  if (input.changes.modules !== undefined) {
    if (!Array.isArray(input.changes.modules)) throw new Error('La lista de módulos no se entiende.');
    const fuera = input.changes.modules.filter((m) => !input.knownModules.includes(m));
    if (fuera.length) throw new Error(`Estos módulos no existen: ${fuera.join(', ')}.`);
    valores.push(JSON.stringify(input.changes.modules));
    sets.push(`modules = $${valores.length}`);
  }
  if (!sets.length) throw new Error('No llegó ningún cambio.');
  const r = await client.query(`UPDATE plan_limits SET ${sets.join(', ')} WHERE plan = $1 RETURNING *`, valores);
  if (r.rowCount === 0) throw new Error(`Plan desconocido: ${input.plan}.`);
  await input.auditar(client, { actor: input.actor, plan: input.plan, changes: input.changes });
  olvidarPlanes();
  return r.rows[0];
}
