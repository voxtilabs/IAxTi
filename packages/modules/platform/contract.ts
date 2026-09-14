// Única puerta pública del módulo platform (SPEC §26).
export const MODULE_ID = 'platform' as const;
export { listTenants, isPlatformAdmin, grantPlatformAdmin } from './application/platform';
export type { TenantSummary } from './application/platform';
export {
  tenantDetail,
  adminCreateTenant,
  adminSetTenantState,
  adminChangePlan,
  adminExtendTrial,
  startSupportSession,
  endSupportSession,
  supportStatus,
} from './application/tenants-admin';
export type { TenantDetail } from './application/tenants-admin';
export {
  listPlans,
  updatePlan,
  modulesAdmin,
  setModuleFlag,
  applyModuleFlags,
  tenantRetentionPreview,
  setRetentionOverridePlatform,
} from './application/planes';
export type { PlanRow, ModuleAdminRow } from './application/planes';
export { healthSnapshot, securitySnapshot, estadoGeneral } from './application/salud';
export type { Chequeo, EstadoSalud, Seguridad, SaludInput } from './application/salud';
