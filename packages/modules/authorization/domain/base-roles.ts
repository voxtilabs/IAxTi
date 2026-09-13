// ÚNICO lugar del código donde un rol base se traduce a permisos.
// En el resto de la plataforma está PROHIBIDO condicionar por rol
// (ADR-0008; el grep de CI lo caza). La matriz completa es SPEC §23:
// cada módulo nuevo aporta permisos al catálogo y esta tabla decide qué
// paquete los recibe. Los roles custom (issue #73) se resuelven por base
// de datos clonando un base.

export const BASE_ROLES = ['SUPERADMIN', 'ADMIN', 'SUPERVISOR', 'USER'] as const;
export type BaseRole = (typeof BASE_ROLES)[number];

export function isBaseRole(name: string): name is BaseRole {
  return (BASE_ROLES as readonly string[]).includes(name);
}

type Rule = (permission: string) => boolean;

const RULES: Record<BaseRole, Rule> = {
  // Cross-tenant: opera la plataforma y audita; no vende ni configura tenants.
  SUPERADMIN: (p) => p.startsWith('platform.') || p === 'audit.read',
  // Todo lo del tenant salvo la plataforma.
  ADMIN: (p) => !p.startsWith('platform.'),
  // Coordina: ve equipo y tenant; no configura ni factura (SPEC §23).
  SUPERVISOR: (p) => ['users.read', 'tenant.read', 'teams.manage', 'audit.read'].includes(p),
  // Opera lo propio; el detalle por módulo lo agrega cada fase según §23.
  USER: (p) => ['tenant.read'].includes(p),
};

/**
 * ¿El paquete del rol base incluye este permiso? `catalog` es el catálogo
 * generado desde los manifiestos (ModuleRegistry.permissionsCatalog): un
 * permiso fuera de catálogo jamás se concede, tenga la regla que tenga.
 */
export function baseRoleHasPermission(
  role: BaseRole,
  permission: string,
  catalog: ReadonlySet<string>,
): boolean {
  if (!catalog.has(permission)) return false;
  return RULES[role](permission);
}
