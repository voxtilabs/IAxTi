// Única puerta pública del módulo organizations (SPEC §26).
export const MODULE_ID = 'organizations' as const;
export {
  createTenant,
  getTenant,
  changeTenantState,
  changePlan,
  getPlanLimits,
  advanceOnboarding,
} from './application/tenants';
export type { Tenant, PlanLimits } from './application/tenants';
export { incrementUsage, getUsage, periodStart } from './application/usage';
export type { UsageMetric } from './application/usage';
export type { TenantState, OnboardingState } from './domain/state';
