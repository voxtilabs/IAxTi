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
  return (await permisosDelActorConEstado(client, actor)).permisos;
}

/**
 * Lo mismo, diciendo si el conjunto se pudo RESOLVER.
 *
 * `permisosDelActor` devuelve el conjunto vacío cuando los permisos de un rol
 * propio no se pueden leer de la base, y para decidir si se deja pasar una
 * petición eso es lo correcto: un rol que no se pudo resolver no se interpreta
 * con generosidad.
 *
 * Pero para DIBUJAR no sirve, y la diferencia importa. Si el menú se filtra
 * por este conjunto, un error transitorio de la base deja a la persona con un
 * menú vacío y sin explicación — el mismo modo de falla que #789. «No tiene
 * permisos» y «no pudimos averiguarlo» se ven iguales y son cosas distintas:
 * la primera se dibuja, la segunda se degrada a mostrar todo y dejar que la
 * API siga siendo la que manda (#814).
 */
export async function permisosDelActorConEstado(
  client: PoolClient,
  actor: Actor,
): Promise<{ permisos: Set<string>; resuelto: boolean }> {
  if (actor.kind === 'apikey') {
    return { permisos: new Set((actor.scopes ?? []).filter((p) => catalog.has(p))), resuelto: true };
  }
  // El soporte entra a mirar, nunca a configurar: su conjunto es fijo y de
  // solo lectura, sin importar el rol con el que figure.
  if (actor.kind === 'soporte') {
    return {
      permisos: new Set([...PERMISOS_DE_SOPORTE].filter((p) => catalog.has(p))),
      resuelto: true,
    };
  }
  const rol = actor.role;
  if (isBaseRole(rol)) {
    return {
      permisos: new Set([...catalog].filter((p) => baseRoleHasPermission(rol, p, catalog))),
      resuelto: true,
    };
  }
  // Rol propio del negocio: sus permisos viven en la base.
  const propios = await customRolePermissions(client, actor.tenantId, actor.role).catch(() => null);
  return {
    permisos: new Set((propios ?? []).filter((p) => catalog.has(p))),
    resuelto: propios !== null,
  };
}
