import type IORedis from 'ioredis';

/**
 * Caché de lecturas en Redis (#711).
 *
 * Medido el 06/10 contra staging, desde dentro del VPS: **postgres 64 ms**
 * estable —333 ms en frío— para un `SELECT 1`, y **redis 0 ms**. La base es
 * Supabase y está lejos; Redis está en la misma máquina.
 *
 * O sea: cada consulta cuesta 64 ms de viaje, haga lo que haga. Una petición con
 * tres consultas son 192 ms antes de ejecutar una línea de lógica, y abrir una
 * conversación son 21 peticiones. Ahí se van los segundos, y no en una consulta
 * lenta: no hay ninguna.
 *
 * Esto es para lo que **no cambia entre dos clics**: los campos propios, las
 * etiquetas, el acceso a módulos, los ajustes. Cambian cuando alguien configura
 * algo, no cuando navega.
 *
 * Tres reglas, y las tres por un motivo:
 *
 *   · **La clave lleva el tenant SIEMPRE** (`.claude/rules/db.md`). Un caché sin
 *     prefijo es una filtración entre clientes, no un bug de rendimiento.
 *   · **Si la respuesta depende de quién pregunta, el actor va en la clave.** Un
 *     caché por tenant que ignore el rol filtra entre usuarios del mismo negocio
 *     — alguien sin permiso ve lo que cacheó un administrador.
 *   · **Un fallo de Redis no rompe la lectura.** Si Redis no contesta, se va a la
 *     base y listo. Lo contrario sería cambiar lentitud por caída.
 */

export interface OpcionesDeCache {
  /** Qué se está guardando. Entra en la clave; que sea estable. */
  clave: string;
  /** El dueño del dato. Obligatorio: no hay caché sin tenant. */
  tenantId: string;
  /**
   * Quién pregunta, cuando la respuesta depende de su permiso.
   *
   * Omitirlo cuando NO depende es correcto y comparte el valor entre todo el
   * negocio. Omitirlo cuando sí depende es una filtración.
   */
  actorId?: string;
  /** Cuánto vive. Corto: el precio es ver lo viejo durante ese rato. */
  ttlSegundos: number;
}

/** `cache:{tenant}:{clave}` — y el actor cuando la respuesta es suya. */
export function claveDeCache(o: OpcionesDeCache): string {
  return o.actorId
    ? `cache:${o.tenantId}:${o.actorId}:${o.clave}`
    : `cache:${o.tenantId}:${o.clave}`;
}

/**
 * Lee del caché, y si no está, lo trae y lo guarda.
 *
 * Devuelve lo mismo que `traer`, pasado por JSON. Lo que no sobrevive a
 * `JSON.stringify` —una fecha vuelve como texto— no se puede cachear con esto
 * sin convertirlo: quien llama decide la forma.
 */
export async function leerConCache<T>(
  redis: Pick<IORedis, 'get' | 'set'> | null,
  opciones: OpcionesDeCache,
  traer: () => Promise<T>,
): Promise<T> {
  if (!redis) return traer();
  const clave = claveDeCache(opciones);
  try {
    const guardado = await redis.get(clave);
    if (guardado !== null) return JSON.parse(guardado) as T;
  } catch {
    // Redis caído: se sigue a la base. Cambiar lentitud por caída sería un
    // mal negocio.
  }
  const valor = await traer();
  try {
    await redis.set(clave, JSON.stringify(valor), 'EX', opciones.ttlSegundos);
  } catch {
    // Lo mismo: no poder guardar no puede impedir contestar.
  }
  return valor;
}

/**
 * Borra lo cacheado de una clave para un tenant, pase quien pase.
 *
 * Se llama al ESCRIBIR. Un caché que muestra lo viejo después de guardar es peor
 * que la lentitud que vino a arreglar: la lentitud se nota y se aguanta; el dato
 * viejo se cree.
 *
 * Borra también las variantes por actor —`cache:{tenant}:*:{clave}`— porque
 * quien edita un campo propio lo edita para todo el negocio.
 */
export async function olvidarEnCache(
  redis: Pick<IORedis, 'del' | 'scan'> | null,
  entrada: { clave: string; tenantId: string },
): Promise<void> {
  if (!redis) return;
  const directa = `cache:${entrada.tenantId}:${entrada.clave}`;
  const patron = `cache:${entrada.tenantId}:*:${entrada.clave}`;
  try {
    await redis.del(directa);
    // `scan` y no `keys`: `keys` bloquea Redis entero mientras recorre, y acá
    // Redis es lo único que está rápido.
    let cursor = '0';
    do {
      const [siguiente, encontradas] = await redis.scan(cursor, 'MATCH', patron, 'COUNT', 100);
      cursor = siguiente;
      if (encontradas.length > 0) await redis.del(...encontradas);
    } while (cursor !== '0');
  } catch {
    // Si no se pudo olvidar, lo peor que pasa es que se vea lo viejo hasta que
    // venza el TTL. Por eso el TTL es corto.
  }
}
