import type { Pool, PoolClient } from 'pg';

/**
 * Un pool cuyo despachador solo ve los eventos de ESTA prueba.
 *
 * ## Por qué hace falta
 *
 * El outbox es de todos: `tick()` toma los cincuenta pendientes MÁS VIEJOS de
 * la base, sin mirar de quién son. En la base compartida de las pruebas eso
 * rompe de dos maneras a la vez —los eventos recién publicados pueden quedar
 * fuera del lote, y el número que `tick()` devuelve es el de los ajenos—.
 *
 * ## Por qué no `drenar()`
 *
 * La primera salida fue vaciar el outbox antes de cada caso, con un
 * despachador de consumidores vacíos. Funciona, pero tiene un costo que no se
 * ve: **marca como procesados los eventos pendientes de las demás pruebas**
 * que corren en paralelo. La prueba que los publicó los encuentra consumidos
 * por nadie, y el rojo aparece en otro archivo.
 *
 * Acotar es mejor que vaciar: se reescribe el `SELECT` del despachador para
 * que mire solo los ids del propio fixture. El resto —la transacción, el
 * savepoint por evento, los reintentos, el `FOR UPDATE SKIP LOCKED`, el RLS—
 * es el de producción, sin tocar.
 *
 * La idea es de #939 (Sebastian), que llegó a ella por el mismo camino.
 *
 * ## La trampa de `connect`
 *
 * `connect` tiene dos formas y hay que honrar las dos: `pool.query()` de `pg`
 * no usa la de promesa, llama `this.connect((err, client, release) => …)` con
 * CALLBACK. Una envoltura que solo devuelva promesa deja cualquier
 * `pool.query` esperando a nadie — cuarenta segundos y sigue (#913).
 */
export function outboxAcotado(real: Pool, ids: Array<number | string>): Pool {
  const soloLosNuestros = (sql: string) =>
    sql.includes('FROM outbox') && sql.includes('FOR UPDATE SKIP LOCKED');

  const envolver = (cliente: PoolClient): PoolClient => {
    const consultar = cliente.query.bind(cliente) as unknown as (...a: unknown[]) => unknown;
    return new Proxy(cliente, {
      get(destino, prop, receptor) {
        if (prop !== 'query') return Reflect.get(destino, prop, receptor);
        return (...args: unknown[]) => {
          const [texto, ...resto] = args;
          if (typeof texto === 'string' && soloLosNuestros(texto)) {
            const valores = (resto[0] ?? []) as unknown[];
            return consultar(
              texto.replace('ORDER BY id', `AND id = ANY($${valores.length + 1}::bigint[]) ORDER BY id`),
              [...valores, ids],
            );
          }
          return consultar(...args);
        };
      },
    }) as PoolClient;
  };

  return new Proxy(real, {
    get(destino, prop, receptor) {
      if (prop !== 'connect') return Reflect.get(destino, prop, receptor);
      return (cb?: (e: Error | undefined, c?: PoolClient, release?: unknown) => void) => {
        if (typeof cb === 'function') {
          return (destino.connect as unknown as (f: typeof cb) => unknown)((e, c, release) =>
            cb(e, c ? envolver(c) : c, release),
          );
        }
        return destino.connect().then(envolver);
      };
    },
  });
}
