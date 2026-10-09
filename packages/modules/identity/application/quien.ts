import type { PoolClient } from 'pg';

/**
 * Quién hizo esto (#697).
 *
 * Nueve columnas guardan QUIÉN hizo cada cosa —apagó la IA, lanzó la campaña,
 * aprobó lo que propuso el agente, se quedó con la conversación— y ninguna
 * pantalla lo mostraba. No es vanidad de auditoría: son las preguntas que se
 * hacen cuando algo sale mal, y en un equipo de tres personas se hacen seguido.
 *
 * El `audit_log` tiene parte de esto, pero se lee desde Auditoría y con permiso:
 * no es lo mismo que ver «lo apagó Carla, ayer a las 19:00» donde está el
 * interruptor.
 *
 * Vive en identity porque el nombre vive en `user_profiles` y la pertenencia en
 * `user_roles`: los dos son de identity, y el resto de los módulos no puede
 * consultarlos. Se expone por el contrato, se recibe un id y se devuelve un
 * nombre.
 */

export interface Quien {
  userId: string;
  /** El nombre del perfil. Null si nunca completó uno. */
  nombre: string | null;
  /**
   * Si sigue en el equipo de este negocio.
   *
   * Importa para la pantalla: a alguien que ya no está no se le muestra el UUID
   * —no significa nada para quien lee— se dice que ya no está.
   *
   * `null` cuando la pregunta no corresponde — ámbito plataforma, vía
   * `quienesSonEnLaPlataforma`: un SuperAdmin que apagó el Agente General no
   * pertenece al equipo de ningún negocio, y decir «ya no está en el equipo» de
   * alguien que nunca estuvo sería afirmar algo falso.
   */
  enElEquipo: boolean | null;
}

/**
 * Resuelve varios ids de una vez, DENTRO del tenant.
 *
 * De a uno sería una consulta por fila de la lista; acá la lista entera cuesta
 * un viaje. Los nulos y repetidos se descartan antes de preguntar.
 *
 * Pide un `PoolClient` de verdad y no un `Pick<..., 'query'>` a propósito:
 * `user_roles` tiene RLS, así que esta consulta SOLO es correcta dentro de un
 * `withTenant`. Suelta al pool, con el rol de producción, la política evaluaría
 * `tenant_id = NULL` y devolvería cero filas **sin error** — y entonces todo el
 * mundo saldría como «alguien que ya no está en el equipo». Una respuesta falsa
 * presentada como un hecho, que es justo el defecto que este issue viene a
 * sacar. La guarda de #286 lo caza, y tenía razón.
 */
export async function quienesSon(
  client: PoolClient,
  tenantId: string,
  userIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, Quien>> {
  const ids = idsLimpios(userIds);
  if (ids.length === 0) return new Map();
  const r = await client.query(
    `SELECT u.id,
            p.name AS nombre,
            EXISTS (
              SELECT 1 FROM user_roles ur WHERE ur.tenant_id = $2 AND ur.user_id = u.id
            ) AS en_el_equipo
       FROM unnest($1::uuid[]) AS u(id)
       LEFT JOIN user_profiles p ON p.user_id = u.id`,
    [ids, tenantId],
  );
  return new Map(
    r.rows.map((f) => [
      f.id as string,
      {
        userId: f.id as string,
        nombre: (f.nombre as string) ?? null,
        enElEquipo: f.en_el_equipo as boolean,
      },
    ]),
  );
}

/**
 * Lo mismo en ámbito PLATAFORMA: el nombre, sin preguntar por pertenencia.
 *
 * Es para quien apagó el Agente General o tocó un flag de módulo: un
 * SuperAdmin, que no pertenece al equipo de ningún negocio. Por eso
 * `enElEquipo` llega en `null` y no en `false` — decir «ya no está en el
 * equipo» de alguien que nunca estuvo sería afirmar algo falso.
 *
 * Y por eso NO consulta `user_roles`: no hay tenant por el que preguntar, el
 * panel corre fuera de `withTenant`, y `user_profiles` no tiene RLS porque no
 * lleva tenant. Dos ámbitos, dos consultas: una sola con un `tenantId` nulo
 * dejaría una tabla con RLS en un camino que corre suelto al pool.
 */
export async function quienesSonEnLaPlataforma(
  client: Pick<PoolClient, 'query'>,
  userIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, Quien>> {
  const ids = idsLimpios(userIds);
  if (ids.length === 0) return new Map();
  const r = await client.query(
    `SELECT u.id, p.name AS nombre
       FROM unnest($1::uuid[]) AS u(id)
       LEFT JOIN user_profiles p ON p.user_id = u.id`,
    [ids],
  );
  return new Map(
    r.rows.map((f) => [
      f.id as string,
      { userId: f.id as string, nombre: (f.nombre as string) ?? null, enElEquipo: null },
    ]),
  );
}

/** Sin nulos, sin vacíos y sin repetidos: lo que vale la pena preguntar. */
function idsLimpios(userIds: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(userIds.filter((x): x is string => typeof x === 'string' && x.length > 0))];
}

/**
 * El relleno para un id que la consulta no devolvió.
 *
 * Que un id no esté en el mapa significa que no hay perfil ni pertenencia: se
 * muestra como «alguien que ya no está», nunca como un UUID. Está acá y no
 * repetido en cada módulo para que la respuesta sea una sola.
 */
export function quienFue(quien: Map<string, Quien> | undefined, userId: unknown): Quien | null {
  if (typeof userId !== 'string' || userId === '') return null;
  return quien?.get(userId) ?? { userId, nombre: null, enElEquipo: false };
}

/** Lo mismo para UN id, que es el caso del interruptor y de la ficha. */
export async function quienEs(
  client: PoolClient,
  tenantId: string,
  userId: string | null | undefined,
): Promise<Quien | null> {
  if (!userId) return null;
  return (await quienesSon(client, tenantId, [userId])).get(userId) ?? null;
}
