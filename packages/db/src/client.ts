import { Pool } from 'pg';

/**
 * El pool de la aplicación.
 *
 * Los dos tiempos de espera no son afinado fino: son la diferencia entre que
 * un problema se vea y que no.
 *
 * `pg` viene con `connectionTimeoutMillis: 0`, que significa **esperar para
 * siempre**. Cuando la base no contesta —no que rechace: que se coma los
 * paquetes— cada consulta se queda colgada sin decir nada, y la aplicación
 * se ve viva mientras no puede hacer nada. Es exactamente lo que pasó con
 * staging (#241): `/health` en 200, `/ready` colgado en su propio tope, y
 * ninguna pista de qué estaba mal hasta que se miró desde el otro lado.
 *
 * Con un tope, el mismo problema dice su nombre en los logs a los cinco
 * segundos y en el arranque de cada servicio.
 */
/**
 * El tope de conexión, validado.
 *
 * Era `Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5_000)`, y para pg un 0 no
 * es "inmediato": es SIN TOPE. O sea que dejar la variable en blanco —la
 * forma normal de desactivar algo en un panel— cambiaba "falla a los 5 s" por
 * "se cuelga para siempre", que es el peor cambio posible en una sonda de
 * salud: /ready nunca responde en vez de decir qué pasa.
 *
 * La misma validación que `enteroDeEntorno` en @iaxti/core, escrita acá a
 * mano a propósito: este paquete no depende de nadie más que `pg` y `yaml`, y
 * mantenerlo así vale más que ahorrarse cinco líneas.
 */
function timeoutDeConexion(): number {
  const crudo = process.env.DB_CONNECT_TIMEOUT_MS;
  if (crudo === undefined || crudo.trim() === '') return 5_000;
  const n = Number(crudo);
  if (!Number.isFinite(n) || n < 1) {
    console.warn(
      `entorno: DB_CONNECT_TIMEOUT_MS="${crudo}" no sirve (se esperaba un número ≥ 1). ` +
        'Se usan 5000 ms. Con 0, pg NO pone tope y la conexión se cuelga en vez de fallar.',
    );
    return 5_000;
  }
  return n;
}

/**
 * Cuántas conexiones abre CADA proceso.
 *
 * Era el defecto de `pg` —10— elegido por nadie. La instancia de staging
 * tiene `max_connections: 60` y Supabase ya se lleva unas quince con
 * PostgREST, realtime, pg_net y el propio Supavisor; los procesos que abren
 * pool son dos (api y workers), y cada uno puede correr en varias réplicas.
 *
 * Seis por proceso deja margen de sobra contra el pooler en modo
 * transacción, donde una conexión se sostiene lo que dura la transacción y
 * no lo que dura la petición.
 */
function tamanoDelPool(): number {
  const crudo = process.env.DB_POOL_MAX;
  if (crudo === undefined || crudo.trim() === '') return 6;
  const n = Number(crudo);
  if (!Number.isFinite(n) || n < 1) {
    console.warn(
      `entorno: DB_POOL_MAX="${crudo}" no sirve (se esperaba un número ≥ 1). Se usan 6.`,
    );
    return 6;
  }
  return Math.floor(n);
}

export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL no está definida');
  }
  const pool = new Pool({
    connectionString,
    max: tamanoDelPool(),
    // Cinco segundos para CONSEGUIR una conexión. Una base sana en la misma
    // región contesta en menos de uno; cinco deja margen para un arranque
    // frío sin volverse una espera eterna.
    connectionTimeoutMillis: timeoutDeConexion(),
    // Una conexión ociosa se suelta a los 30 s: el pooler de Supabase tiene
    // un techo de conexiones y guardarlas sin usar se las quita a otro.
    idleTimeoutMillis: 30_000,
  });

  /**
   * Una conexión ociosa que se muere es NORMAL contra un pooler, no una
   * excepción de la aplicación.
   *
   * `pg` emite 'error' en el pool cuando el servidor cierra una conexión
   * que estaba guardada sin usar. Sin nadie escuchando, Node lo trata como
   * error no manejado: se va a Sentry con una pila que no pasa por nuestro
   * código (`node:net → Socket.emit → pg/connection`) y se lleva por
   * delante la petición que tocaba.
   *
   * Pasó de verdad y está medido: diez de los doce issues del proyecto en
   * Sentry son esto, incluido el `500` que perdió un mensaje entrante
   * (#361). Nueve de ellos mientras Lino navegaba la aplicación.
   *
   * El pool ya descarta la conexión muerta y abre otra solo. Lo único que
   * faltaba era no confundir eso con un fallo.
   */
  pool.on('error', (error) => {
    console.warn(
      'base: se cayó una conexión que estaba ociosa en el pool. ' +
        'La petición en curso NO se vio afectada y el pool ya abrió otra. ' +
        `Detalle: ${error.message}`,
    );
  });

  return pool;
}
