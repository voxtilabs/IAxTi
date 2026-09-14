import { baseRoleHasPermission, isBaseRole } from '@iaxti/module-authorization';
import { registry } from '../registry';
import type { Actor } from './authz.guard';

const catalog = new Set(registry.permissionsCatalog().keys());

/**
 * ¿El actor tiene este permiso? Para decisiones DENTRO de un caso de uso
 * (p. ej. "¿ve todo el equipo o solo lo suyo?"). Pasa por el traductor
 * único de ADR-0008: aquí tampoco se condiciona por rol.
 */
export function actorCan(actor: Actor, permission: string): boolean {
  return isBaseRole(actor.role) ? baseRoleHasPermission(actor.role, permission, catalog) : false;
}
