import type { PoolClient } from 'pg';
import { baseRoleHasPermission, customRolePermissions, isBaseRole } from '@iaxti/module-authorization';
import { registry } from '../registry';
import type { Actor } from './authz.guard';

const catalog = new Set(registry.permissionsCatalog().keys());

/**
 * Lo que el soporte de IAxTi puede mirar dentro de la cuenta de un cliente
 * (issue 219). Duplica la lista del guard a propósito: son la MISMA
 * política, pero el guard decide por petición y esto arma el conjunto
 * completo para filtrar herramientas antes de ofrecerlas.
 */
const PERMISOS_DE_SOPORTE = new Set([
  'conversations.read',
  'conversations.read_all',
  'crm.contacts.read',
  'crm.deals.read',
  'crm.read_all',
]);

/**
 * ¿El actor tiene este permiso? Para decisiones DENTRO de un caso de uso
 * (p. ej. "¿ve todo el equipo o solo lo suyo?"). Pasa por el traductor
 * único de ADR-0008: aquí tampoco se condiciona por rol.
 */
export function actorCan(actor: Actor, permission: string): boolean {
  if (actor.kind === 'apikey') {
    return catalog.has(permission) && (actor.scopes ?? []).includes(permission);
  }
  return isBaseRole(actor.role) ? baseRoleHasPermission(actor.role, permission, catalog) : false;
}


/**
 * TODOS los permisos del actor, de una vez (#493).
 *
 * `actorCan` responde una pregunta por llamada, que es lo que necesita un
 * caso de uso. El Agente General necesita lo contrario: el conjunto
 * completo, para filtrar sus 195 herramientas ANTES de ofrecérselas al
 * modelo. Sin eso, el modelo pediría cosas que la persona no puede y
 * gastaría un turno en cada 403.
 *
 * Es el MISMO traductor de ADR-0008 —acá tampoco se condiciona por rol—,
 * solo recorrido al revés: por cada permiso del catálogo, se pregunta.
 */
export async function permisosDelActor(
  client: PoolClient,
  actor: Actor,
): Promise<Set<string>> {
  if (actor.kind === 'apikey') {
    return new Set((actor.scopes ?? []).filter((p) => catalog.has(p)));
  }
  // El soporte entra a mirar, nunca a configurar: su conjunto es fijo y de
  // solo lectura, sin importar el rol con el que figure.
  if (actor.kind === 'soporte') {
    return new Set([...PERMISOS_DE_SOPORTE].filter((p) => catalog.has(p)));
  }
  const rol = actor.role;
  if (isBaseRole(rol)) {
    return new Set([...catalog].filter((p) => baseRoleHasPermission(rol, p, catalog)));
  }
  // Rol propio del negocio: sus permisos viven en la base. Si no se puede
  // resolver, el conjunto queda VACÍO — sin permisos no hay herramientas, y
  // eso es lo correcto: un rol desconocido no se interpreta con generosidad.
  const propios = await customRolePermissions(client, actor.tenantId, actor.role).catch(() => null);
  return new Set((propios ?? []).filter((p) => catalog.has(p)));
}
