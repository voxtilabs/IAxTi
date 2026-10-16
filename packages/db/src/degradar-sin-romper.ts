import type { PoolClient } from 'pg';

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
export async function degradarSinRomper<T>(
  client: PoolClient,
  intentar: (c: PoolClient) => Promise<T>,
  alFallar: (error: Error) => T | Promise<T>,
): Promise<T> {
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
