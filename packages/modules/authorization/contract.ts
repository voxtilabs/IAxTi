// Única puerta pública del módulo authorization (SPEC §26).
export const MODULE_ID = 'authorization' as const;
export { BASE_ROLES, baseRoleHasPermission, isBaseRole } from './domain/base-roles';
export type { BaseRole } from './domain/base-roles';
