// Única puerta pública del módulo platform (SPEC §26).
export const MODULE_ID = 'platform' as const;
export { listTenants, isPlatformAdmin, grantPlatformAdmin } from './application/platform';
export type { TenantSummary } from './application/platform';
