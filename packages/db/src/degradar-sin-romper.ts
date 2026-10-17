import type { Pool } from 'pg';

/**
 * El punto al que se vuelve. Fijo a propósito: Postgres permite repetir el
 * nombre —el nuevo tapa al anterior— y como esta función libera el suyo antes
 * de devolver, el anidamiento queda en orden.
 */
const PUNTO = 'degradar_sin_romper';

/**
 * Una lectura que puede fallar SIN llevarse puesta la transacción de quien
 * llamó (#962).
 *
 * El patrón que esto reemplaza estaba escrito en nueve sitios del repo:
 *
 * ```ts
 * const extra = await leerAlgo(client, …).catch(() => null);
 * ```
 *
 * La intención es buena —ese dato es una mejora, no un requisito— pero en
 * Postgres una sentencia que falla **aborta el bloque entero**. Y estas
 * funciones reciben el `PoolClient` de quien llama, que casi siempre viene
 * dentro de una transacción: el despachador del outbox, la purga, una
 * mutación de la API. Así que tragarse el error no deja las cosas como
 * estaban: deja la transacción inservible, y todo lo que venga después
 * contesta `current transaction is aborted, commands ignored until end of
 * transaction block`.
 *
 * Lo caro de eso no es el fallo, es el mensaje: no nombra la tabla, ni la
 * consulta, ni el permiso que faltaba. Medido con el consumidor de analytics
 * y un rol sin `SELECT` en `tenants`, el evento se agotaba a los cinco
 * intentos y el `last_error` del outbox no decía nada útil.
 *
 * Con el savepoint, «si no se puede, seguimos» es verdad: al volver a él, la
 * transacción del llamador queda usable.
 *
 * Fuera de una transacción no hay savepoints y tampoco hacen falta —una
 * sentencia que falla no arrastra a las siguientes—, así que ahí la función
 * se comporta como el `try/catch` de toda la vida. Se pregunta probando,
 * porque `SAVEPOINT` suelto lanza `25P01 no transaction in progress`.
 *
 * El `alFallar` recibe el error de verdad: degradar en silencio fue la mitad
 * del problema. Quien llama sabe qué decir y en qué términos.
 */
export async function degradarSinRomper<T, C extends Pick<Pool, 'query'>>(
  client: C,
  intentar: (c: C) => Promise<T>,
  alFallar: (error: Error) => T | Promise<T>,
): Promise<T> {
  // Genérico en el cliente, y no `PoolClient` fijo, porque hay lecturas que
  // reciben `PoolClient | Pick<Pool, 'query'>` —`modulosDelPlan`,
  // `activeSupportSession`— y son justo las que más necesitan esto: con un
  // `Pool` el `.catch` no rompe nada, con un cliente ajeno rompe todo, y quien
  // las escribe no sabe cuál le va a tocar. Abajo solo se usa `.query`.
  //
  // El `.catch` de esta línea es EL sitio donde atrapar está bien y es el
  // propósito: es la pregunta «¿estoy dentro de una transacción?», que no se
  // puede hacer de otra forma —`SAVEPOINT` suelto lanza `25P01`—. Por eso la
  // regla de #966 lo exceptúa acá y en ningún otro lado.
  // eslint-disable-next-line iaxti/catch-sobre-cliente-ajeno -- es la sonda del propio helper
  const enTransaccion = await client
    .query(`SAVEPOINT ${PUNTO}`)
    .then(() => true)
    .catch(() => false);
  try {
    const valor = await intentar(client);
    if (enTransaccion) await client.query(`RELEASE SAVEPOINT ${PUNTO}`);
    return valor;
  } catch (error) {
    // Lo primero, antes que nada: devolverle al llamador una transacción con
    // la que pueda seguir trabajando.
    if (enTransaccion) await client.query(`ROLLBACK TO SAVEPOINT ${PUNTO}`);
    return alFallar(error as Error);
  }
}
