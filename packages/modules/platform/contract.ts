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
  activeSupportSession,
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
// El centro de control del Agente General (#496, ADR-0025): verlo y poder
// apagarlo desde afuera, sin desplegar.
export {
  agenteGeneralApagado,
  apagarAgenteGeneral,
  encenderAgenteGeneral,
  corridasDelAgenteGeneral,
  resumenDelAgenteGeneral,
} from './application/agente-general-panel';
export type {
  EstadoDelApagado,
  CorridaDelAgente,
  ResumenDelAgente,
} from './application/agente-general-panel';
export {
  healthSnapshot,
  securitySnapshot,
  estadoGeneral,
  chequeoCrecimientoMensajes,
  chequeoEventosAbandonados,
} from './application/salud';
export type { Chequeo, EstadoSalud, Seguridad, SaludInput } from './application/salud';
export {
  aiMetrics,
  aiExecutions,
  promptsActivos,
  alertasCosto,
  traceUrl,
} from './application/centro-ia';
export type { FilaIA, EjecucionIA, PromptActivo, AlertaCosto, Agrupacion } from './application/centro-ia';
