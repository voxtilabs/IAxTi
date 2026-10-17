import type { Pool } from 'pg';

/**
 * El punto al que se vuelve, con nombre PROPIO por llamada (#991).
 *
 * Esto era un nombre fijo, y el comentario decía que estaba bien «porque esta
 * función libera el suyo antes de devolver, el anidamiento queda en orden».
 * Vale cuando una llamada va DESPUÉS de la otra; no vale cuando se intercalan,
 * y en este repo se intercalan: `copilot.ts` tenía cuatro lecturas opcionales
 * dentro de un `Promise.all` sobre el mismo `PoolClient` (#966).
 *
 * Con el nombre repetido, Postgres TAPA el punto anterior, así que:
 *
 *     A: SAVEPOINT p
 *     B: SAVEPOINT p          -- tapa al de A
 *     A: falla -> ROLLBACK TO p   -- vuelve al de B
 *
 * y lo medido es peor que «se pisan»: **la que falló conservó su trabajo y la
 * que salió bien lo perdió**. La prueba de #991 lo deja en una línea —
 * `expected [ 'antes', 'de A' ] to deeply equal [ 'antes', 'de B' ]`.
 *
 * Un contador por proceso alcanza: los nombres solo tienen que ser distintos
 * entre llamadas vivas sobre la misma conexión, y dos procesos no comparten
 * conexión. El número va interpolado sin comillas porque es un número que
 * genera esta línea, no un dato de nadie.
 */
let proximoPunto = 0;

/**
 * Qué clientes tienen una degradación EN VUELO, y por qué hace falta saberlo.
 *
 * Los nombres propios arreglan la mitad del problema —que una llamada vuelva al
 * punto de otra— pero no la otra mitad, y la otra mitad no se puede arreglar:
 * los savepoints son una PILA. Volver a uno anterior destruye todos los que se
 * abrieron después, así que si A falla mientras B está en vuelo, el trabajo de
 * B se va igual y el `RELEASE` de B revienta con
 * «savepoint … does not exist». Medido así, con los nombres ya únicos.
 *
 * O sea: degradar dos lecturas a la vez sobre el MISMO cliente no se puede
 * hacer bien, y no es una limitación de esta función — un cliente de pg atiende
 * una consulta a la vez, así que el `Promise.all` que las lanza juntas ya las
 * estaba encolando. Lo único que agrega es el riesgo.
 *
 * Entonces se dice en voz alta, en el momento, con el arreglo en el mensaje. La
 * alternativa era encolarlas acá adentro, y eso esconde un error de diseño
 * detrás de una espera que nadie pidió.
 *
 * `WeakSet` para no retener clientes: cuando el pool recicla la conexión, el
 * objeto se va y la marca con él.
 */
const enVuelo = new WeakSet<object>();

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
  // El `.catch` del SAVEPOINT de más abajo es EL sitio donde atrapar está bien
  // y es el propósito: es la pregunta «¿estoy dentro de una transacción?», que
  // no se puede hacer de otra forma —`SAVEPOINT` suelto lanza `25P01`—.
  //
  // Tenía acá un `eslint-disable-next-line` de la regla de #966 y lo saqué,
  // porque el lint avisó que no servía para nada: desde #991 el cliente llega
  // como `C extends Pick<Pool, 'query'>` y la regla busca una anotación
  // `PoolClient` literal, así que esta línea ya no le aparece. Queda anotado en
  // la regla, que es donde hay que leerlo; silenciar algo que ya nadie mira es
  // la forma de que la próxima excepción se escriba por costumbre.
  if (enVuelo.has(client)) {
    throw new Error(
      'degradarSinRomper: ya hay una degradación en vuelo sobre este cliente. ' +
        'Los savepoints son una pila: si la primera falla, se lleva el trabajo de la ' +
        'segunda y la segunda revienta con «savepoint does not exist». Ponelas EN SERIE ' +
        '—un await después del otro—, que es lo que un cliente de pg hace igual: ' +
        'atiende una consulta a la vez (#991).',
    );
  }
  const punto = `degradar_sin_romper_${(proximoPunto += 1)}`;
  enVuelo.add(client);
  const enTransaccion = await client
    .query(`SAVEPOINT ${punto}`)
    .then(() => true)
    .catch(() => false);
  try {
    const valor = await intentar(client);
    if (enTransaccion) await client.query(`RELEASE SAVEPOINT ${punto}`);
    return valor;
  } catch (error) {
    // Lo primero, antes que nada: devolverle al llamador una transacción con
    // la que pueda seguir trabajando.
    if (enTransaccion) await client.query(`ROLLBACK TO SAVEPOINT ${punto}`);
    return alFallar(error as Error);
  } finally {
    // En los dos caminos y también si `alFallar` tira: la marca es del tramo,
    // no del resultado. Sin el `finally`, un `alFallar` que falle dejaría el
    // cliente marcado para siempre y la próxima lectura opcional de ESA
    // conexión moriría con el mensaje de arriba, que ahí sería mentira.
    enVuelo.delete(client);
  }
}
