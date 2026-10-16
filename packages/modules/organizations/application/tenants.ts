import { olvidarPlan } from './plan-modulos';
import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
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
  stateSince: Date | null;
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
    stateSince: (row.state_since as Date) ?? null,
  };
}

/** El tenant nace en trial con fecha de fin y los módulos del plan Crece (SPEC §6). */
export async function createTenant(
  client: PoolClient,
  input: { name: string; rubro?: string; id?: string; description?: string },
): Promise<Tenant> {
  const result = await client.query(
    `INSERT INTO tenants (name, rubro, plan, state, trial_ends_at, id, settings)
     VALUES ($1, $2, 'crece', 'trial', now() + make_interval(days => $3),
             COALESCE($4::uuid, gen_random_uuid()), $5::jsonb)
     RETURNING *`,
    [input.name, input.rubro ?? null, TRIAL_DAYS, input.id ?? null,
      JSON.stringify(input.description ? { businessDescription: input.description } : {})],
  );
  const tenant = rowToTenant(result.rows[0]);
  // El manifiesto declara `tenant.created` desde el primer día y no lo
  // publicaba nadie: quien escribiera un consumidor (onboarding, avisos,
  // métricas) se habría quedado esperando para siempre.
  await publishEvent(client, {
    name: 'tenant.created',
    tenantId: tenant.id,
    payload: { name: tenant.name, plan: tenant.plan, trialEndsAt: tenant.trialEndsAt },
    actor: 'system',
  });
  return tenant;
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
    // `state_since` arranca de nuevo con cada cambio: los plazos de §6 (30
    // días en solo lectura, 90 suspendido) se cuentan desde acá.
    'UPDATE tenants SET state = $2, state_since = now() WHERE id = $1 RETURNING *',
    [id, to],
  );
  return rowToTenant(result.rows[0]);
}

/** Cambiar de plan recalcula límites (los límites SON la fila de plan_limits). */
export async function changePlan(client: PoolClient, id: string, plan: string): Promise<PlanLimits> {
  const limits = await getPlanLimits(client, plan);
  const antes = await client.query('SELECT plan FROM tenants WHERE id = $1', [id]);
  const anterior = (antes.rows[0]?.plan as string | undefined) ?? null;
  await client.query('UPDATE tenants SET plan = $2 WHERE id = $1', [id, plan]);
  // Sin esto, subir de plan tardaría hasta cinco minutos en notarse: el
  // cliente paga y la función sigue negada (issue 209).
  olvidarPlan(id);
  // `tenant.plan_changed` estaba declarado en el manifiesto desde el primer
  // día, catalogado en SPEC §24, y con un consumidor REGISTRADO en
  // `conversations` —el que difiere la purga 30 días y avisa con la cantidad
  // exacta (§39)—. No lo publicaba nadie.
  //
  // Sin esta línea, bajar de Equipo (retención ilimitada) a Base (12 meses)
  // borraba el historial en la corrida de las 04:00 del MISMO día: borrado
  // FÍSICO de conversaciones, mensajes, notas y los objetos de R2, sin los 30
  // días de gracia y sin el aviso. El camino peor es el automático: cuando la
  // prueba se vence sin plan elegido, `billing` llama acá con 'base' sin que
  // ninguna persona apriete nada.
  //
  // El aviso lo decide el consumidor y no esta función: cuánto retiene cada
  // plan y cuántas conversaciones capturaría el corte nuevo es cosa de
  // `conversations`. Acá solo se cuenta QUÉ cambió.
  if (anterior !== plan) {
    await publishEvent(client, {
      name: 'tenant.plan_changed',
      tenantId: id,
      payload: { from: anterior, to: plan },
      actor: 'system',
    });
  }
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
