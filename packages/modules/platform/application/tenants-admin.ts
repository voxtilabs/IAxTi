import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';
import {
  changePlan,
  changeTenantState,
  createTenant,
  getTenant,
  getUsage,
  type TenantState,
} from '@iaxti/module-organizations';

// Gestión de tenants del SuperAdmin (#68, SPEC §22): operar diez clientes
// pagando sin tocar la base a mano. Cada acción al audit DEL TENANT con
// actor_kind = superadmin — el dueño puede ver quién tocó qué.

async function auditSuperadmin(
  pool: Pool,
  input: { tenantId: string; adminUser: string; action: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await withTenant(pool, input.tenantId, (c) =>
    writeAudit(c, {
      tenantId: input.tenantId,
      actor: input.adminUser,
      actorKind: 'superadmin',
      action: input.action,
      resource: 'tenant',
      resourceId: input.tenantId,
      result: 'ok',
      metadata: input.metadata,
    }),
  );
}

export interface TenantDetail {
  id: string;
  name: string;
  plan: string;
  state: string;
  trialEndsAt: Date | null;
  usage: { conversations: number; iaExecutions: number; apiRequests: number };
  channels: Array<{ kind: string; state: string }>;
  support: { active: boolean; until: Date | null };
}

/** El detalle operativo: estado, plan, uso del mes y salud de canales. */
export async function tenantDetail(client: PoolClient, tenantId: string): Promise<TenantDetail> {
  const t = await client.query(
    `SELECT id, name, plan, state, trial_ends_at FROM tenants WHERE id = $1`,
    [tenantId],
  );
  if (t.rowCount === 0) throw new Error('No encontramos ese tenant.');
  const canales = await client.query(
    `SELECT kind, state FROM channel_accounts WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  const soporte = await client.query(
    `SELECT ends_at FROM platform_support_sessions
      WHERE tenant_id = $1 AND ended_at IS NULL AND ends_at > now()
      ORDER BY ends_at DESC LIMIT 1`,
    [tenantId],
  );
  const [conversations, iaExecutions, apiRequests] = await Promise.all([
    getUsage(client, tenantId, 'conversations'),
    getUsage(client, tenantId, 'ia_executions'),
    getUsage(client, tenantId, 'api_requests'),
  ]);
  return {
    id: t.rows[0].id,
    name: t.rows[0].name,
    plan: t.rows[0].plan,
    state: t.rows[0].state,
    trialEndsAt: t.rows[0].trial_ends_at ?? null,
    usage: { conversations, iaExecutions, apiRequests },
    channels: canales.rows.map((c) => ({ kind: c.kind, state: c.state })),
    support: {
      active: (soporte.rowCount ?? 0) > 0,
      until: soporte.rows[0]?.ends_at ?? null,
    },
  };
}

export async function adminCreateTenant(
  pool: Pool,
  input: { name: string; plan?: string; rubro?: string; adminUser: string },
): Promise<{ id: string }> {
  if (!input.name?.trim()) throw new Error('El tenant necesita un nombre.');
  const client = await pool.connect();
  let tenant: { id: string };
  try {
    // Nace en trial con el plan por defecto de la spec; si el SuperAdmin
    // pidió otro, se cambia al tiro (mismo camino que la operación).
    tenant = await createTenant(client, { name: input.name.trim(), rubro: input.rubro });
    if (input.plan) await changePlan(client, tenant.id, input.plan);
  } finally {
    client.release();
  }
  await auditSuperadmin(pool, {
    tenantId: tenant.id,
    adminUser: input.adminUser,
    action: 'platform.tenant.create',
    metadata: { name: input.name.trim(), plan: input.plan ?? 'crece' },
  });
  return { id: tenant.id };
}

/** Suspender pasa por la máquina de estados §6 — sin saltos piratas. */
export async function adminSetTenantState(
  pool: Pool,
  input: { tenantId: string; action: 'suspend' | 'reactivate'; adminUser: string },
): Promise<{ state: string }> {
  const resultado = await withTenant(pool, input.tenantId, async (client) => {
    const tenant = await getTenant(client, input.tenantId);
    const from = tenant.state as TenantState;
    if (input.action === 'suspend') {
      if (from === 'active') {
        await changeTenantState(client, input.tenantId, 'past_due');
        await changeTenantState(client, input.tenantId, 'read_only');
        await changeTenantState(client, input.tenantId, 'suspended');
      } else if (from === 'read_only') {
        await changeTenantState(client, input.tenantId, 'suspended');
      } else if (from !== 'suspended') {
        throw new Error(`No se puede suspender desde "${from}".`);
      }
      return 'suspended';
    }
    if (from === 'suspended' || from === 'read_only' || from === 'past_due' || from === 'trial') {
      await changeTenantState(client, input.tenantId, 'active');
    } else if (from !== 'active') {
      throw new Error(`No se puede reactivar desde "${from}".`);
    }
    return 'active';
  });
  await auditSuperadmin(pool, {
    tenantId: input.tenantId,
    adminUser: input.adminUser,
    action: `platform.tenant.${input.action}`,
  });
  return { state: resultado };
}

/** Cambia el plan: los límites y módulos del plan aplican al tiro (§6). */
export async function adminChangePlan(
  pool: Pool,
  input: { tenantId: string; plan: string; adminUser: string },
): Promise<{ plan: string }> {
  await withTenant(pool, input.tenantId, (client) => changePlan(client, input.tenantId, input.plan));
  await auditSuperadmin(pool, {
    tenantId: input.tenantId,
    adminUser: input.adminUser,
    action: 'platform.tenant.change_plan',
    metadata: { plan: input.plan },
  });
  return { plan: input.plan };
}

export async function adminExtendTrial(
  pool: Pool,
  input: { tenantId: string; days: number; adminUser: string },
): Promise<{ trialEndsAt: Date }> {
  if (!(Number(input.days) >= 1 && Number(input.days) <= 90)) {
    throw new Error('La extensión va de 1 a 90 días.');
  }
  const r = await pool.query(
    `UPDATE tenants SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, now()), now()) + make_interval(days => $2)
      WHERE id = $1 RETURNING trial_ends_at`,
    [input.tenantId, input.days],
  );
  if (r.rowCount === 0) throw new Error('No encontramos ese tenant.');
  await auditSuperadmin(pool, {
    tenantId: input.tenantId,
    adminUser: input.adminUser,
    action: 'platform.tenant.extend_trial',
    metadata: { days: input.days },
  });
  return { trialEndsAt: r.rows[0].trial_ends_at };
}

/**
 * Modo soporte (#68): LECTURA del tenant por tiempo acotado, con aviso
 * VISIBLE al tenant (supportStatus lo consulta la app) y registro en
 * audit — ayudar sin violar la confianza.
 */
export async function startSupportSession(
  pool: Pool,
  input: { tenantId: string; adminUser: string; hours?: number; reason?: string },
): Promise<{ until: Date }> {
  const horas = Math.min(Math.max(Number(input.hours ?? 4), 1), 24);
  const r = await pool.query(
    `INSERT INTO platform_support_sessions (tenant_id, admin_user, reason, ends_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING ends_at`,
    [input.tenantId, input.adminUser, input.reason ?? null, horas],
  );
  await auditSuperadmin(pool, {
    tenantId: input.tenantId,
    adminUser: input.adminUser,
    action: 'platform.support.start',
    metadata: { hours: horas, reason: input.reason ?? null },
  });
  return { until: r.rows[0].ends_at };
}

export async function endSupportSession(
  pool: Pool,
  input: { tenantId: string; adminUser: string },
): Promise<void> {
  await pool.query(
    `UPDATE platform_support_sessions SET ended_at = now()
      WHERE tenant_id = $1 AND ended_at IS NULL`,
    [input.tenantId],
  );
  await auditSuperadmin(pool, {
    tenantId: input.tenantId,
    adminUser: input.adminUser,
    action: 'platform.support.end',
  });
}

/** El AVISO del tenant: la app lo muestra mientras el soporte mira. */
export async function supportStatus(
  client: PoolClient,
  tenantId: string,
): Promise<{ active: boolean; until: Date | null }> {
  const r = await client.query(
    `SELECT ends_at FROM platform_support_sessions
      WHERE tenant_id = $1 AND ended_at IS NULL AND ends_at > now()
      ORDER BY ends_at DESC LIMIT 1`,
    [tenantId],
  );
  return { active: (r.rowCount ?? 0) > 0, until: r.rows[0]?.ends_at ?? null };
}
