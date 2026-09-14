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

// Matriz SPEC §23 aplicada al catálogo actual; cada módulo nuevo agrega aquí
// lo que sus roles reciben. USER opera lo propio (la verificación de dueño
// la agrega el caso de uso); SUPERVISOR coordina; ADMIN configura.
const USER_PERMS = new Set([
  'tenant.read',
  'crm.contacts.read',
  'crm.contacts.create',
  'crm.contacts.update',
  'crm.deals.read',
  'crm.deals.create',
  'crm.deals.update',
  'crm.deals.close',
  'crm.activities.manage',
  // SPEC §23: opera SUS conversaciones; la verificación de dueño la agrega
  // el caso de uso (read_all es el interruptor "ver todo el equipo").
  'conversations.read',
  'conversations.reply',
  'conversations.resolve',
  'conversations.notes',
]);

const SUPERVISOR_EXTRA = new Set([
  'users.read',
  'teams.manage',
  'audit.read',
  'crm.contacts.merge',
  'crm.contacts.export',
  'conversations.read_all',
  'conversations.assign',
  'quickreplies.manage',
]);

const RULES: Record<BaseRole, Rule> = {
  // Cross-tenant: opera la plataforma y audita; no vende ni configura tenants.
  SUPERADMIN: (p) => p.startsWith('platform.') || p === 'audit.read',
  // Todo lo del tenant salvo la plataforma.
  ADMIN: (p) => !p.startsWith('platform.'),
  SUPERVISOR: (p) => USER_PERMS.has(p) || SUPERVISOR_EXTRA.has(p),
  USER: (p) => USER_PERMS.has(p),
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
