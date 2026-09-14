// Única puerta pública del módulo authorization (SPEC §26).
export const MODULE_ID = 'authorization' as const;
export { BASE_ROLES, baseRoleHasPermission, isBaseRole } from './domain/base-roles';
export type { BaseRole } from './domain/base-roles';
export { createApiKey, listApiKeys, revokeApiKey, resolveApiKey } from './application/apikeys';
export type { ApiKey, ResolvedApiKey } from './application/apikeys';
export {
  listRoles,
  createCustomRole,
  updateCustomRolePermissions,
  assignRole,
  customRolePermissions,
} from './application/roles';
export type { Role } from './application/roles';
