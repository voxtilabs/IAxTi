import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { checkReadiness, TIMEOUT_MS, TIMEOUT_SALIDA_MS } from '../src/readiness';

/**
 * `/ready` tiene que decir POR QUÉ, no solo que no llegó (#241).
 *
 * Durante días staging respondió exactamente esto:
 *
 *   {"nombre":"postgres","ok":false,"ms":2002,"detalle":"no respondió en 2000 ms"}
 *
 * Es cierto y no sirve. El tope corta a los 2 s, el error real del pool
 * llega después, y la carrera siempre la ganaba el tope — así que la causa
 * se perdía. Hubo que buscarla desde el otro lado, mirando las conexiones
 * en Supabase.
 *
 * Distinguirlas importa: ENOTFOUND es DNS, "connection timeout" es que los
 * paquetes se pierden, ECONNREFUSED es que no hay nadie escuchando. Tres
 * problemas distintos con tres arreglos distintos.
 */
function poolQueTarda(ms: number, error?: Error): Pool {
  return {
    query: () =>
      new Promise((resolve, reject) =>
        setTimeout(() => (error ? reject(error) : resolve({ rows: [] })), ms),
      ),
  } as unknown as Pool;
}

// El entorno NO decide el resultado de estos tests.
//
// `checkReadiness` mira `DATABASE_URL` para decir a qué puerto intentó, así
// que si la variable está o no está cambia el texto del detalle. En mi
// máquina no estaba y en CI sí: los mismos tests, verdes acá y rojos allá.
// Un test que depende del ambiente no prueba lo que dice probar.
const DSN_ORIGINAL = process.env.DATABASE_URL;
beforeEach(() => {
  delete process.env.DATABASE_URL;
});

/**
 * «El proceso lleva rato vivo», dicho a mano.
 *
 * Misma doctrina que el bloque de acá arriba, aplicada al reloj: desde #852 el
 * detalle cambia según hace cuánto arrancó el proceso —con el contenedor
 * recién levantado no publica un diagnóstico de red—, y si no se fija, eso lo
 * decide cuánto hace que arrancó el worker de vitest. La misma prueba diría
 * «arrancando» cuando le toca correr primera y otra cosa cuando le toca al
 * minuto. Las que no son sobre el arranque lo fijan acá; las que SÍ son sobre
 * el arranque pasan su propio número.
 */
const CALIENTE = { levantadoHaceMs: 10 * 60_000 } as const;

/**
 * Topes chicos, para las pruebas que no son sobre los topes.
 *
 * Guardan la RELACIÓN que importa (la salida se da más que la base) con dos
 * órdenes de magnitud menos de reloj. Los números de fábrica los fija su
 * propia prueba, al final del archivo: con esperas reales este archivo se
 * llevaba cuarenta y cinco segundos del paquete y dejaba sin CPU a las
 * pruebas de los demás, que se caen por su propio tope de 5 s.
 */
const RAPIDO = { ...CALIENTE, topeMs: 60, topeDeSalidaMs: 200 } as const;
afterEach(() => {
  if (DSN_ORIGINAL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = DSN_ORIGINAL;
});

describe('el detalle de /ready', () => {
  it('la primera sonda solo alcanza a decir que no llegó', async () => {
    const pool = poolQueTarda(4000, new Error('connect ETIMEDOUT 15.229.150.166:5432'));
    // Sin CALIENTE el detalle traería además la nota de arranque y este
    // `toBe` pasaría a depender de la hora a la que corre la prueba.
    const r = await checkReadiness(pool, 'api', CALIENTE);
    const pg = r.dependencias.find((d) => d.nombre === 'postgres')!;
    expect(pg.ok).toBe(false);
    expect(pg.detalle).toBe('no respondió en 2000 ms');
  }, 15_000);

  it('la siguiente ya dice la causa, aunque haya llegado tarde', async () => {
    const pool = poolQueTarda(100, new Error('connect ETIMEDOUT 15.229.150.166:5432'));
    // La primera guarda el motivo al rechazar.
    await checkReadiness(pool, 'api', CALIENTE);
    const r = await checkReadiness(pool, 'api', CALIENTE);
    const pg = r.dependencias.find((d) => d.nombre === 'postgres')!;
    // Acá el error llega dentro del tope, así que se ve directo.
    expect(pg.detalle).toMatch(/ETIMEDOUT/);
  }, 15_000);

  it('un fallo lento termina apareciendo en la sonda siguiente', async () => {
    const lento = poolQueTarda(2500, new Error('getaddrinfo ENOTFOUND aws-0-sa-east-1.pooler.supabase.com'));
    // La primera se corta en el tope: el error todavía viene en camino.
    const primera = await checkReadiness(lento, 'api', CALIENTE);
    expect(primera.dependencias[0].ok).toBe(false);
    expect(primera.dependencias[0].detalle).toMatch(/no respondió en 2000 ms/);
    expect(primera.dependencias[0].detalle).not.toMatch(/ENOTFOUND/);

    // Se le da tiempo a que el error lento aterrice.
    await new Promise((r) => setTimeout(r, 800));
    const segunda = await checkReadiness(lento, 'api', CALIENTE);
    // Esto es lo que habría ahorrado días: la sonda dice DNS o dice red.
    expect(segunda.dependencias[0].detalle).toMatch(/ENOTFOUND/);
  }, 20_000);

  it('cuando vuelve a andar, no arrastra el motivo viejo', async () => {
    /**
     * Tres sondas: falla, anda, y vuelve a fallar sin causa (#838).
     *
     * Esto afirmaba `detalle).toBeUndefined()` sobre una sonda EN VERDE, y la
     * rama de éxito de `medir()` devuelve `{ nombre, ok: true, ms }` sin campo
     * `detalle`, siempre, pase lo que pase con el mapa `ultimoFallo`. La
     * aserción no podía fallar.
     *
     * El defecto que nombra se manifiesta en el SIGUIENTE fallo: con el
     * `ultimoFallo.delete(nombre)` borrado, la sonda empezaría a culpar a una
     * caída de hace horas —«no respondió en 2000 ms — la vez anterior: <error
     * antiguo>»— y eso es lo que hay que comprobar.
     *
     * ## Con el módulo RECIÉN importado, y eso también es un hallazgo
     *
     * `ultimoFallo` es un `Map` a nivel de MÓDULO. La primera versión de esta
     * prueba se puso roja con un motivo que no era el suyo —`getaddrinfo
     * ENOTFOUND aws-0-sa-east-1.pooler.supabase.com`, un host que este caso
     * nunca usa—, o sea que el mapa venía con la basura de otra prueba del
     * mismo worker. Una prueba que mide estado compartido entre pruebas no
     * mide lo que dice medir, y los `vi.resetModules()` del archivo no la
     * tocaban porque nadie reimportaba.
     */
    vi.resetModules();
    const { checkReadiness: sonda } = await import('../src/readiness');
    const roto = poolQueTarda(100, new Error('connect ENOTFOUND db.vieja.invalid'));
    await sonda(roto, 'api', CALIENTE);
    // 1 · el motivo quedó guardado: si esto no pasa, lo de abajo no prueba nada.
    const conMotivo = await sonda(roto, 'api', CALIENTE);
    expect(conMotivo.dependencias[0].detalle).toMatch(/ENOTFOUND/);

    // 2 · anda: el mapa se limpia.
    const sano = poolQueTarda(5);
    const verde = await sonda(sano, 'api', CALIENTE);
    expect(verde.dependencias[0].ok).toBe(true);
    expect(verde.dependencias[0].detalle).toBeUndefined();

    // 3 · y el fallo siguiente, sin causa propia, NO nombra el de antes.
    const mudo = poolQueTarda(4000);
    const otraVez = await sonda(mudo, 'api', CALIENTE);
    expect(otraVez.dependencias[0].ok).toBe(false);
    expect(otraVez.dependencias[0].detalle).toBe('no respondió en 2000 ms');
    expect(
      otraVez.dependencias[0].detalle,
      'la sonda está culpando a una caída anterior: `ultimoFallo` no se limpió al andar',
    ).not.toMatch(/ENOTFOUND|la vez anterior/);
  }, 25_000);
});

describe('cuando postgres no conecta, dice a qué puerto (#241)', () => {
  it('el puerto sale en el detalle del fallo', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:6543/postgres';
    const pool = {
      query: () => new Promise(() => {}), // nunca responde: el caso real
    } as unknown as Pool;
    // RAPIDO y no los topes de fábrica: esta prueba es sobre el PUERTO en el
    // detalle, no sobre cuánto se espera. Con los de fábrica se quedaba dos
    // segundos de reloj real y en la corrida completa del paquete —63 archivos
    // peleando por la CPU— se pasaba del tope de 5 s de vitest y salía roja
    // sin que nada estuviera mal. Pasó: 8742 ms.
    const r = await checkReadiness(pool, 'api', RAPIDO);
    const pg = r.dependencias.find((d) => d.nombre === 'postgres')!;
    expect(pg.ok).toBe(false);
    // Un timeout se ve idéntico venga del puerto que venga. Sin esto, desde
    // afuera no hay forma de saber si el contenedor tomó el valor nuevo.
    expect(pg.detalle).toContain('puerto 6543');
  });

  it('NO publica host, usuario ni contraseña', async () => {
    process.env.DATABASE_URL = 'postgres://elusuario:lacontrasena@db.interna.cl:5432/postgres';
    const pool = { query: () => new Promise(() => {}) } as unknown as Pool;
    const r = await checkReadiness(pool, 'api', RAPIDO);
    const detalle = JSON.stringify(r);
    // Un diagnóstico no justifica publicar a dónde nos conectamos.
    expect(detalle).not.toContain('lacontrasena');
    expect(detalle).not.toContain('elusuario');
    expect(detalle).not.toContain('db.interna.cl');
    expect(detalle).toContain('puerto 5432');
  });

  it('en verde no agrega nada: el puerto ahí es ruido', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:6543/postgres';
    const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
    const r = await checkReadiness(pool, 'api', RAPIDO);
    const pg = r.dependencias.find((d) => d.nombre === 'postgres')!;
    expect(pg.ok).toBe(true);
    expect(pg.detalle ?? '').not.toContain('puerto');
  });
});

describe('cuando falla, dice si el contenedor sale a internet (#241)', () => {
  const FETCH_REAL = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = FETCH_REAL;
    delete process.env.SUPABASE_URL;
  });

  it('443 OK + Postgres no: sale a internet y le bloquean ESE puerto', async () => {
    // Las dos causas se ven idénticas desde afuera —un timeout y nada más—
    // y Redis no las distingue: vive en la red interna del compose, así que
    // responder en 2 ms no dice nada de la salida.
    process.env.SUPABASE_URL = 'https://proyecto.supabase.co';
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:6543/postgres';
    globalThis.fetch = (async () => new Response('ok')) as unknown as typeof fetch;
    const pool = { query: () => new Promise(() => {}) } as unknown as Pool;
    const pg = (await checkReadiness(pool, 'api', RAPIDO)).dependencias.find(
      (d) => d.nombre === 'postgres',
    )!;
    expect(pg.detalle).toContain('puerto 6543');
    expect(pg.detalle).toContain('sale a internet: sí');
  });

  it('443 tampoco: no tiene salida y el puerto no tiene nada que ver', async () => {
    process.env.SUPABASE_URL = 'https://proyecto.supabase.co';
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:6543/postgres';
    // Con la forma que de verdad tiene un fallo de `fetch` en este Node: la
    // tapa es `TypeError: fetch failed` y el motivo vive en `cause`.
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), { code: 'ETIMEDOUT' }),
      });
    }) as unknown as typeof fetch;
    const pool = { query: () => new Promise(() => {}) } as unknown as Pool;
    const pg = (await checkReadiness(pool, 'api', RAPIDO)).dependencias.find(
      (d) => d.nombre === 'postgres',
    )!;
    expect(pg.detalle).toContain('sale a internet: NO');
    // Y sigue siendo el fallo de postgres: la sonda EXPLICA, no reemplaza.
    expect(pg.ok).toBe(false);
  });

  it('en VERDE no llama a nadie', async () => {
    process.env.SUPABASE_URL = 'https://proyecto.supabase.co';
    let llamadas = 0;
    globalThis.fetch = (async () => {
      llamadas += 1;
      return new Response('ok');
    }) as unknown as typeof fetch;
    const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
    const r = await checkReadiness(pool, 'api', RAPIDO);
    expect(r.dependencias.find((d) => d.nombre === 'postgres')!.ok).toBe(true);
    // Una sonda de diagnóstico que llama afuera en cada chequeo de salud es
    // tráfico y latencia por nada. Solo corre cuando ya hay un problema.
    expect(llamadas).toBe(0);
  });

  it('sin SUPABASE_URL no inventa una conclusión', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:5432/postgres';
    const pool = { query: () => new Promise(() => {}) } as unknown as Pool;
    const pg = (await checkReadiness(pool, 'api', RAPIDO)).dependencias.find(
      (d) => d.nombre === 'postgres',
    )!;
    expect(pg.detalle).toContain('puerto 5432');
    expect(pg.detalle).not.toContain('sale a internet');
  });
});

/**
 * El tope agotado no siempre es un corte de red, ni siempre deja de serlo (#852).
 *
 * El discriminador de #241 publicaba dos lecturas: el `AbortError` del propio
 * tope entraba por el mismo `catch` que un `ECONNREFUSED` y salía como «sale a
 * internet: NO (timeout)». Un NO rotundo sobre algo que nunca se comprobó. Y
 * las dos sondas compartían el tope de 2 s, así que un arranque en frío —que
 * hace tardar a las dos por el mismo motivo— producía exactamente la lectura
 * «no tiene salida», la que manda a mirar la red del VPS, el firewall y
 * Cloudflare. Staging contestó eso con `ms: 2003` y veinte segundos después
 * estaba todo en verde.
 *
 * ## Lo que NO alcanzaba con mandar todo timeout a «no concluyente»
 *
 * El corte de red más común —el firewall que descarta los paquetes en vez de
 * rechazarlos, que es el incidente fundador de #241— tampoco contesta: lo
 * corta nuestro tope, da `AbortError`, y con la regla simple quedaba también
 * como «no se pudo comprobar». Eso es cambiar un ruido por un silencio.
 * Medido con `fetch` de verdad en este Node: un destino que se come los
 * paquetes rechaza con `name: 'AbortError'` recién a los 3002 ms de un tope de
 * 3000; uno que rechaza la conexión lo hace a los 221 ms con
 * `cause.code: 'ECONNREFUSED'`.
 *
 * Lo que separa las dos no es el error, que es el mismo: es hace cuánto que el
 * proceso está vivo. Por eso estas pruebas vienen de a pares —el mismo
 * silencio, con el proceso recién levantado y con el proceso levantado hace
 * rato— y por eso el uptime se pasa a mano: ver el par es ver la distinción.
 *
 * ## Por qué corren rápido
 *
 * Antes esperaban los topes de fábrica (7 s solo la primera) con el argumento
 * de que la relación entre dos topes reales no se prueba con un temporizador
 * falso. Lo segundo sigue siendo cierto y acá no se usa temporizador falso:
 * los topes son reales, solo que chicos. Lo que cambia con 60 y 200 ms en vez
 * de 2000 y 5000 es la cuenta del reloj, no el mecanismo — y los números de
 * fábrica tienen su propia prueba al final. El costo de la versión lenta no
 * era teórico: este archivo se llevaba 45 s del paquete y empujaba a otras
 * pruebas por encima de su tope de 5 s.
 */
describe('tope agotado vs. sin salida: dos cosas distintas (#852)', () => {
  const FETCH_REAL = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = FETCH_REAL;
    delete process.env.SUPABASE_URL;
  });

  /** El pooler frío: no contesta nunca, solo lo corta el tope. */
  const poolMudo = () => ({ query: () => new Promise(() => {}) }) as unknown as Pool;

  function escenario() {
    process.env.SUPABASE_URL = 'https://proyecto.supabase.co';
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:6543/postgres';
  }

  /**
   * Un `fetch` que tarda `ms` y que OBEDECE el `signal`, como undici.
   *
   * Lo segundo es la mitad que importa, y se aprendió al revés: la primera
   * versión de este doble resolvía a los 3 s ignorando el `signal`, así que
   * «443 contesta pasado el tope de la base» pasaba igual con el tope
   * compartido — la prueba del tope propio no probaba el tope. Un doble que no
   * aborta convierte cualquier tope en ninguno.
   */
  function fetchQueTarda(ms: number): typeof fetch {
    return ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((resolver, rechazar) => {
        const t = setTimeout(() => resolver(new Response('ok')), ms);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          rechazar(new DOMException('This operation was aborted', 'AbortError'));
        });
      })) as unknown as typeof fetch;
  }

  const detalleDePostgres = async (opciones: Record<string, number>) =>
    (await checkReadiness(poolMudo(), 'api', opciones)).dependencias.find(
      (d) => d.nombre === 'postgres',
    )!;

  it('recién levantado, las dos sondas agotan su tope: no concluye nada sobre la red', async () => {
    escenario();
    // No llega a contestar nunca: es el arranque en frío del issue.
    globalThis.fetch = fetchQueTarda(60_000);

    const pg = await detalleDePostgres({ topeMs: 60, topeDeSalidaMs: 200, levantadoHaceMs: 3000 });

    expect(pg.detalle).toContain('no se pudo comprobar');
    // Esto es lo que se arregló: antes decía justo esto, y era falso.
    expect(pg.detalle).not.toContain('sale a internet: NO');
    // Y lo que NO se aflojó: el fallo de la base sigue siendo un fallo. Si
    // esto se pusiera en verde, la sonda de diagnóstico habría empezado a
    // decidir la salud y un corte real se publicaría como instancia lista.
    expect(pg.ok).toBe(false);
  });

  it('el MISMO silencio, con el proceso levantado hace rato, sí es un NO', async () => {
    escenario();
    globalThis.fetch = fetchQueTarda(60_000);

    const pg = await detalleDePostgres({
      topeMs: 60,
      topeDeSalidaMs: 200,
      levantadoHaceMs: 40 * 60_000,
    });

    // El par con la prueba de arriba: mismo fetch, mismo tope, mismo
    // AbortError, y la lectura se da vuelta. Si esto dijera «no se pudo
    // comprobar», el corte que motivó #241 —paquetes que no vuelven, que es
    // justo el que no contesta nada— se publicaría como un encogimiento de
    // hombros, y habríamos cambiado el ruido por un silencio.
    expect(pg.detalle).toContain('sale a internet: NO');
    expect(pg.detalle).not.toContain('no se pudo comprobar');
    // Con el uptime a la vista: quien lo lea puede estar en desacuerdo con el
    // razonamiento y no solo con la conclusión.
    expect(pg.detalle).toContain('40 min');
    expect(pg.detalle).toContain('no es un arranque en frío');
  });

  it('un corte con nombre propio concluye, y publica el código y no el mensaje', async () => {
    escenario();
    /**
     * La forma REAL de un fallo de `fetch`, medida en este Node:
     *
     *   name: 'TypeError', message: 'fetch failed'
     *   cause: { message: 'connect ECONNREFUSED 127.0.0.1:9999', code: 'ECONNREFUSED' }
     *
     * El doble anterior lanzaba un `Error` pelado con el `ECONNREFUSED` en su
     * propio `message`, que es algo que `fetch` no hace nunca: la prueba
     * pasaba por cómo estaba escrito el doble. En producción el detalle decía
     * «sale a internet: NO (fetch failed)».
     */
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
          code: 'ECONNREFUSED',
        }),
      });
    }) as unknown as typeof fetch;

    const pg = await detalleDePostgres({ topeMs: 60, topeDeSalidaMs: 200, levantadoHaceMs: 3000 });

    expect(pg.detalle).toContain('sale a internet: NO');
    expect(pg.detalle).toContain('ECONNREFUSED');
    // La tapa de undici no dice nada y es lo que se publicaba.
    expect(pg.detalle).not.toContain('fetch failed');
    // Un fallo con nombre propio concluye aunque el proceso recién arranque:
    // la red contestó, y contestó que no se llega.
    expect(pg.detalle).not.toContain('no se pudo comprobar');
    // Y el mensaje trae pegada la IP a la que marcamos: va el código, no el
    // mensaje. Misma regla que con DATABASE_URL.
    expect(pg.detalle).not.toContain('10.0.0.1');
  });

  it('la sonda de salida tiene más tope que la base: alcanza a contestar y distingue', async () => {
    escenario();
    // 443 contesta pasado el tope de la base y dentro del propio. Con el tope
    // compartido esto se reportaba como «no tiene salida», que era la lectura
    // más alarmante de las tres y la equivocada.
    globalThis.fetch = fetchQueTarda(120);

    const pg = await detalleDePostgres({ topeMs: 60, topeDeSalidaMs: 400, levantadoHaceMs: 3000 });

    // La lectura útil: sale a internet, le bloquean ESE puerto.
    expect(pg.detalle).toContain('sale a internet: sí');
    expect(pg.detalle).toContain('puerto 6543');
  });

  it('de fábrica, la salida se da más tope que la base', () => {
    // La prueba de arriba corre con topes chicos, así que no diría nada si
    // alguien vuelve a igualar los de verdad. Ésta es esa guardia, y es de las
    // baratas: si vuelven a ser iguales, vuelve el falso «no tiene salida» en
    // cada arranque en frío.
    expect(TIMEOUT_SALIDA_MS).toBeGreaterThan(TIMEOUT_MS);
  });
});

/**
 * Que el detalle diga que el proceso está arrancando cuando lo está (#852,
 * criterio 3).
 *
 * Vale por sí solo, sin sonda de salida de por medio: «la base no contesta» y
 * «la base no contesta y el proceso tiene tres segundos de vida» mandan a
 * hacer cosas distintas, y la segunda es casi siempre «esperá y volvé a
 * pedir». Que es, literalmente, lo que cuenta el issue: veinte segundos
 * después estaba todo verde, y entre medio se le dijo al dueño que staging
 * estaba caído de la base.
 */
describe('el detalle avisa cuando el proceso recién arrancó (#852)', () => {
  it('recién levantado: lo dice, con hace cuánto', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:6543/postgres';
    const pool = { query: () => new Promise(() => {}) } as unknown as Pool;

    const pg = (
      await checkReadiness(pool, 'api', { topeMs: 60, levantadoHaceMs: 3000 })
    ).dependencias.find((d) => d.nombre === 'postgres')!;

    expect(pg.detalle).toContain('todavía está arrancando');
    expect(pg.detalle).toContain('3 s levantado');
  });

  it('levantado hace rato: no lo dice, porque sería una excusa', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:6543/postgres';
    const pool = { query: () => new Promise(() => {}) } as unknown as Pool;

    const pg = (
      await checkReadiness(pool, 'api', { topeMs: 60, levantadoHaceMs: 10 * 60_000 })
    ).dependencias.find((d) => d.nombre === 'postgres')!;

    // El par. Sin esta mitad, un `detalle` que dijera «arrancando» siempre
    // pasaría la prueba de arriba sin mirar el reloj.
    expect(pg.detalle).not.toContain('arrancando');
    expect(pg.detalle).toContain('puerto 6543');
  });

  it('la ventana de arranque se cierra, y entonces el silencio del 443 acusa', async () => {
    process.env.SUPABASE_URL = 'https://proyecto.supabase.co';
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:6543/postgres';
    const nunca = ((_u: string, init?: { signal?: AbortSignal }) =>
      new Promise((_r, rechazar) => {
        init?.signal?.addEventListener('abort', () =>
          rechazar(new DOMException('This operation was aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const anterior = globalThis.fetch;
    globalThis.fetch = nunca;
    try {
      const pool = { query: () => new Promise(() => {}) } as unknown as Pool;
      // Justo del otro lado de la ventana, que acá se achica para no esperar
      // un minuto: lo que se prueba es que la ventana DECIDE, no su tamaño.
      const pg = (
        await checkReadiness(pool, 'api', {
          topeMs: 60,
          topeDeSalidaMs: 200,
          ventanaDeArranqueMs: 5000,
          levantadoHaceMs: 5001,
        })
      ).dependencias.find((d) => d.nombre === 'postgres')!;
      expect(pg.detalle).not.toContain('arrancando');
      expect(pg.detalle).toContain('sale a internet: NO');
    } finally {
      globalThis.fetch = anterior;
      delete process.env.SUPABASE_URL;
    }
  });
});
