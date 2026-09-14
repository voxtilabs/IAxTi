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
  'notifications.manage_own',
  'agents.use', // "Usar el copiloto" ✓ USER (matriz §23)
  'analytics.read', // sus propios números (#66); read_all es de supervisión
  'knowledge.read', // consultar productos/precios del catálogo ✓ USER (#51)
  'automations.enroll', // meter SU conversación a una secuencia (#63)
  'payments.create_link', // cobrar desde el chat, con tope del tenant (#60, §23)
  'payments.read',
]);

const SUPERVISOR_EXTRA = new Set([
  'roles.read', // ver roles y catálogo (#73); crear/editar/asignar es del ADMIN
  'payments.create_link_unlimited', // cobra sin tope (§23); el USER tiene tope
  'analytics.read_all', // los números de todo el equipo (#66, §23)
  'automations.read', // ver reglas y corridas (§23); configurar es del ADMIN
  'users.read',
  'teams.manage',
  'audit.read',
  'crm.contacts.merge',
  'crm.contacts.export',
  'crm.read_all',
  'conversations.read_all',
  'conversations.assign',
  'quickreplies.manage',
  'agents.usage.read', // "Ver consumo y costo de IA" ✓ SUPERVISOR (§23)
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
