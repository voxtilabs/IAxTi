import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Actor } from './authz.guard';
import { permisosDelActor } from './can';
import { registry } from '../registry';

/**
 * Nadie reparte poder por encima de sí mismo (#567).
 *
 * #556 cerró este agujero en la invitación y dejó abiertas tres puertas al mismo
 * sitio, todas con solo `roles.manage`: asignar cualquier rol a cualquiera —uno
 * mismo incluido—, poner cualquier permiso del catálogo en un rol propio, y
 * clonar ADMIN. Y las tres son PEORES que la invitación: esa necesita un correo,
 * un enlace y que alguien acepte; `assign` es inmediato y no deja a quién
 * preguntarle.
 *
 * En #554 anuncié la garantía «nadie invita por encima de sí mismo» con una de
 * las cuatro puertas cerrada. Eso es peor que no haberla anunciado: alguien lo
 * lee y deja de mirar. Por eso la regla se muda ACÁ, con un solo dueño, y las
 * cuatro rutas pasan por el mismo sitio. Cuatro copias de una regla de
 * autorización se separan, y la que se queda vieja es justo la que alguien va a
 * usar.
 */

/**
 * Los permisos que MANDAN: los que reparten poder o tocan plata y configuración.
 *
 * Por qué no se compara el conjunto ENTERO: cualquier rol asignable tiene más
 * permisos que un rol angosto —hasta un USER—, así que comparar todo dejaba al
 * delegado sin poder incorporar ni asignar a NADIE. Delegar el onboarding y que
 * el delegado no pueda hacer nada es no delegar.
 *
 * `roles.read`, `users.read` y `tenant.read` NO están: leer quién es quién no
 * reparte nada, y meterlos volvería a romper la delegación.
 *
 * Hay una guarda que falla el PR si aparece un permiso nuevo de estas familias y
 * nadie decide si manda o no: una lista curada se muere sola.
 */
export const MANDAN = new Set([
  'roles.manage',
  'users.invite',
  'users.manage',
  'tenant.settings',
  'tenant.billing',
  'apikeys.manage',
  'payments.manage_providers',
  'agents.configure',
  'channels.manage',
  'webhooks.manage',
]);

/**
 * Qué permisos de los que manda tiene ese rol y NO tiene quien lo reparte.
 *
 * El catálogo filtra los dos lados: los permisos de un rol propio salen crudos
 * de la base, y un permiso renombrado en un `module.yaml` dejaría en la fila un
 * string que nadie puede tener — así ni el ADMIN podría repartir ese rol, con un
 * mensaje que no explicaría por qué (#556).
 */
export async function loQueNoPuedoRepartir(
  client: PoolClient,
  actor: Actor,
  permisosDelRol: readonly string[],
): Promise<string[]> {
  const mios = await permisosDelActor(client, actor);
  const catalogo = new Set(registry.permissionsCatalog().keys());
  return permisosDelRol
    .filter((p) => catalogo.has(p))
    .filter((p) => MANDAN.has(p) && !mios.has(p));
}

/**
 * La puerta. Lanza `ROLE_FORBIDDEN` si el rol reparte más de lo que reparte
 * quien lo está repartiendo.
 *
 * `accion` entra en el mensaje porque no es lo mismo «no puedes invitar a
 * alguien con ese rol» que «no puedes asignar ese rol»: quien lo lee está
 * haciendo una de las dos y merece leer la suya.
 */
export async function nadiePorEncimaDeSiMismo(
  client: PoolClient,
  actor: Actor,
  entrada: { rol: string; permisos: readonly string[]; accion: string },
): Promise<void> {
  const deMas = await loQueNoPuedoRepartir(client, actor, entrada.permisos);
  if (deMas.length === 0) return;
  throw new BadRequestException({
    code: 'ROLE_FORBIDDEN',
    message:
      `El rol "${entrada.rol}" puede administrar cosas que tú no administras, así que no puedes ` +
      `${entrada.accion}. Pídeselo a quien administra el negocio.`,
  });
}
