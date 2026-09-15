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
export { incrementUsage, getUsage, periodStart, apiRequestsLimit } from './application/usage';
export { getTenantSettings, updateTenantSettings } from './application/settings';
export type { UsageMetric } from './application/usage';
export type { TenantState, OnboardingState } from './domain/state';
export { puedeEnviar } from './domain/state';
export { zonaDelTenant, olvidarZonas } from './application/zona';
export {
  modulosDelPlan,
  modulosVendibles,
  accesoAlModulo,
  olvidarPlan,
  olvidarPlanes,
} from './application/plan-modulos';
export type { AccesoModulo } from './application/plan-modulos';
