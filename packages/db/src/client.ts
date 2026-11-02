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
/**
 * Diez segundos y no cinco (#1173). Con cinco, una resolución de DNS lenta
 * —y el DNS de este VPS falla seguido: `EAI_AGAIN` 38 veces en 14 días—
 * mataba la petición. Diez segundos de espera es peor experiencia que uno;
 * un error en la cara es peor que los dos.
 *
 * Lo que NO se toca es que HAYA tope: con 0, `pg` espera para siempre y la
 * petición se cuelga en vez de fallar, que es lo que arregló #361.
 */
function timeoutDeConexion(): number {
  const crudo = process.env.DB_CONNECT_TIMEOUT_MS;
  if (crudo === undefined || crudo.trim() === '') return 10_000;
  const n = Number(crudo);
  if (!Number.isFinite(n) || n < 1) {
    console.warn(
      `entorno: DB_CONNECT_TIMEOUT_MS="${crudo}" no sirve (se esperaba un número ≥ 1). ` +
        'Se usan 10000 ms. Con 0, pg NO pone tope y la conexión se cuelga en vez de fallar.',
    );
    return 10_000;
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
/**
 * Cuánto se guarda una conexión ociosa. Cinco minutos y no treinta segundos:
 * ver el porqué en `createPool`. Configurable porque el número correcto
 * depende del pooler que haya al otro lado, y eso cambia por despliegue.
 */
function idleDelPool(): number {
  const crudo = process.env.DB_IDLE_TIMEOUT_MS;
  if (crudo === undefined || crudo.trim() === '') return 300_000;
  const n = Number(crudo);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(
      `entorno: DB_IDLE_TIMEOUT_MS="${crudo}" no sirve (se esperaba un número ≥ 0). ` +
        'Se usan 300000 ms. Con 0, `pg` NO suelta nunca una conexión ociosa.',
    );
    return 300_000;
  }
  return Math.floor(n);
}

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
    /**
     * Las conexiones se GUARDAN, no se sueltan a los 30 s (#1173).
     *
     * Acá decía 30 s, con este motivo: «el pooler de Supabase tiene un techo
     * de conexiones y guardarlas sin usar se las quita a otro». El motivo es
     * cierto y el costo de obedecerlo resultó ser mayor.
     *
     * Medido en Sentry el 02-11: 22 errores en 3 horas en staging, TODOS
     * `Connection terminated due to connection timeout`, y en 14 días 23 de
     * los 25 issues sin resolver. Entre ellos `GET /v1/onboarding` —la
     * pantalla donde se conecta WhatsApp—, que el dueño no pudo abrir.
     *
     * Por qué pasa: con 30 s, medio minuto de silencio deja el pool vacío, y
     * la siguiente petición tiene que resolver DNS, abrir TCP, negociar TLS y
     * autenticar contra un pooler compartido, con 5 s de tope. Cuando algo de
     * esa cadena se demora, la petición muere. Y el DNS de este VPS NO es
     * confiable: `getaddrinfo EAI_AGAIN …pooler.supabase.com` aparece 38 veces
     * en la misma lista. Cada reconexión es otra tirada de esa moneda.
     *
     * Lo que yo había medido antes —63 ms en caliente, 337-478 ms en frío— me
     * hizo concluir que no valía la pena tocarlo. Estaba mal medido el
     * problema: no es que la conexión fría sea lenta, es que A VECES NO SE
     * LOGRA, y eso no sale en un promedio.
     *
     * Qué le cuesta al pooler: `max` son 6 por servicio, o sea 12 entre API y
     * workers. El modo transacción de Supabase está hecho para sostener eso;
     * lo que no está hecho para sostener es reconectar en cada petición.
     */
    idleTimeoutMillis: idleDelPool(),
    /**
     * Y que el socket se mantenga vivo. Un VPS detrás de NAT pierde las
     * conexiones TCP ociosas sin que ninguno de los dos lados se entere: la
     * siguiente consulta escribe en un socket muerto y espera hasta el tope.
     * Desde afuera se ve idéntico a un timeout de conexión, que es la mitad
     * de por qué este error era tan difícil de leer.
     */
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
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
