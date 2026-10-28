import type { Pool, PoolClient } from 'pg';

/** El sufijo del nombre desviado. Público porque alguna prueba fija el mensaje. */
export const SUFIJO_INEXISTENTE = '_que_no_existe';

/**
 * Un pool en el que UNA escritura se cae, sin dejar nada en el esquema
 * compartido (#910).
 *
 * ## Por qué hace falta
 *
 * Una prueba que necesita que una escritura falle —para mirar qué revierte,
 * qué auditoría conserva, en qué estado queda— tenía dos formas de
 * conseguirlo, y las dos tocaban el esquema COMPARTIDO: crear un trigger que
 * lanza, o renombrar la tabla. Con un `finally` parece controlado, pero el
 * `finally` no corre si el proceso muere en el medio —Ctrl-C, OOM, el timeout
 * de la suite— y entonces el trigger se queda en la base para siempre,
 * apuntando a un tenant que ya no existe. Nada falla y nadie se entera, que es
 * la forma más cara de romper algo.
 *
 * Y mientras la ventana está abierta, el objeto es de TODAS las conexiones:
 * los sesenta y pico de archivos que vitest corre en paralelo contra la misma
 * base lo ven. En #913 eso dejó rojos prestados en otros archivos.
 *
 * Acá el desvío va en el TEXTO de la consulta de ESTA conexión. El error lo
 * sigue poniendo Postgres —`relation "…" does not exist`— así que la
 * transacción se aborta de verdad, que suele ser la mitad de lo que la prueba
 * mira, y el catálogo no se toca.
 *
 * ## Por qué acotado por valores
 *
 * Casi nunca se quiere tumbar TODA escritura a una tabla. `writeAudit`, por
 * ejemplo, consulta `audit_log` para encadenar el hash anterior y usa el mismo
 * INSERT para todas las acciones: desviar cualquiera haría fallar la primera
 * que pase, y la prueba dejaría de hablar de lo suyo para hablar de «algo de
 * la auditoría». Por eso el desvío se aplica solo cuando los parámetros de la
 * consulta incluyen el valor que identifica a la escritura buscada.
 *
 * ## La trampa de `connect`
 *
 * `connect` tiene dos formas y hay que honrar las dos: `pool.query()` de `pg`
 * no usa la de promesa, llama `this.connect((err, client, release) => …)` con
 * CALLBACK. Una envoltura que solo devuelva promesa deja cualquier
 * `pool.query` esperando a nadie — cuarenta segundos y sigue (#913). Es la
 * misma trampa que documenta `outbox-acotado`, y se paga igual de caro.
 *
 * @example
 * // La auditoría de ESA acción se cae; el resto de la transacción, no.
 * const caido = escrituraCaida(pool, {
 *   tabla: 'audit_log',
 *   cuandoLosValoresIncluyan: 'whatsapp.invitation.connected',
 * });
 * await procesar(caido, …);
 * expect(await filasDeAuditoria()).toHaveLength(0);
 */
export function escrituraCaida(
  real: Pool,
  opciones: { tabla: string; cuandoLosValoresIncluyan: unknown },
): Pool {
  const { tabla, cuandoLosValoresIncluyan: valorBuscado } = opciones;
  // El `\b` del final deja fuera el nombre ya desviado: `_` es carácter de
  // palabra, así que `audit_log_que_no_existe` no vuelve a calzar.
  const patron = new RegExp(`\\b${tabla.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  const esLaBuscada = (valores: unknown) =>
    Array.isArray(valores) && valores.includes(valorBuscado);
  const desviar = (sql: string, valores: unknown) =>
    esLaBuscada(valores) ? sql.replace(patron, `${tabla}${SUFIJO_INEXISTENTE}`) : null;

  const envolver = (cliente: PoolClient): PoolClient => {
    const consultar = cliente.query.bind(cliente) as unknown as (...a: unknown[]) => unknown;
    return new Proxy(cliente, {
      get(destino, prop, receptor) {
        if (prop !== 'query') return Reflect.get(destino, prop, receptor);
        return (...args: unknown[]) => {
          const [texto, ...resto] = args;
          if (typeof texto === 'string') {
            return consultar(desviar(texto, resto[0]) ?? texto, ...resto);
          }
          const config = texto as { text?: unknown; values?: unknown } | null;
          if (config && typeof config.text === 'string') {
            const cambiado = desviar(config.text, config.values);
            if (cambiado) return consultar({ ...config, text: cambiado }, ...resto);
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
  }) as Pool;
}
