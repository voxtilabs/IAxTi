import type { PoolClient } from 'pg';
import {
  assertOnboardingAdvance,
  assertTransition,
  type OnboardingState,
  type TenantState,
} from '../domain/state';

export interface Tenant {
  id: string;
  name: string;
  rubro: string | null;
  plan: string;
  state: TenantState;
  onboardingState: OnboardingState;
  trialEndsAt: Date | null;
}

export interface PlanLimits {
  plan: string;
  whatsappNumbers: number;
  conversationsMonth: number;
  iaExecutionsMonth: number;
  retentionMonths: number | null;
  apiRequestsMonth: number | null;
  modules: string[];
}

const TRIAL_DAYS = 14;

function rowToTenant(row: Record<string, unknown>): Tenant {
  return {
    id: row.id as string,
    name: row.name as string,
    rubro: (row.rubro as string) ?? null,
    plan: row.plan as string,
    state: row.state as TenantState,
    onboardingState: row.onboarding_state as OnboardingState,
    trialEndsAt: (row.trial_ends_at as Date) ?? null,
  };
}

/** El tenant nace en trial con fecha de fin y los módulos del plan Crece (SPEC §6). */
export async function createTenant(
  client: PoolClient,
  input: { name: string; rubro?: string },
): Promise<Tenant> {
  const result = await client.query(
    `INSERT INTO tenants (name, rubro, plan, state, trial_ends_at)
     VALUES ($1, $2, 'crece', 'trial', now() + make_interval(days => $3))
     RETURNING *`,
    [input.name, input.rubro ?? null, TRIAL_DAYS],
  );
  return rowToTenant(result.rows[0]);
}

export async function getTenant(client: PoolClient, id: string): Promise<Tenant> {
  const result = await client.query('SELECT * FROM tenants WHERE id = $1', [id]);
  if (result.rowCount === 0) throw new Error(`Tenant no encontrado: ${id}`);
  return rowToTenant(result.rows[0]);
}

/** Cambio de estado validado por la máquina de dominio. */
export async function changeTenantState(
  client: PoolClient,
  id: string,
  to: TenantState,
): Promise<Tenant> {
  const current = await getTenant(client, id);
  assertTransition(current.state, to);
  const result = await client.query(
    'UPDATE tenants SET state = $2 WHERE id = $1 RETURNING *',
    [id, to],
  );
  return rowToTenant(result.rows[0]);
}

/** Cambiar de plan recalcula límites (los límites SON la fila de plan_limits). */
export async function changePlan(client: PoolClient, id: string, plan: string): Promise<PlanLimits> {
  const limits = await getPlanLimits(client, plan);
  await client.query('UPDATE tenants SET plan = $2 WHERE id = $1', [id, plan]);
  return limits;
}

export async function getPlanLimits(client: PoolClient, plan: string): Promise<PlanLimits> {
  const result = await client.query('SELECT * FROM plan_limits WHERE plan = $1', [plan]);
  if (result.rowCount === 0) throw new Error(`Plan desconocido: ${plan}`);
  const row = result.rows[0];
  return {
    plan: row.plan,
    whatsappNumbers: row.whatsapp_numbers,
    conversationsMonth: row.conversations_month,
    iaExecutionsMonth: row.ia_executions_month,
    retentionMonths: row.retention_months,
    apiRequestsMonth: row.api_requests_month,
    modules: row.modules,
  };
}

export async function advanceOnboarding(
  client: PoolClient,
  id: string,
  to: OnboardingState,
): Promise<Tenant> {
  const current = await getTenant(client, id);
  assertOnboardingAdvance(current.onboardingState, to);
  const result = await client.query(
    'UPDATE tenants SET onboarding_state = $2 WHERE id = $1 RETURNING *',
    [id, to],
  );
  return rowToTenant(result.rows[0]);
}
