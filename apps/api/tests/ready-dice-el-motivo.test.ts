import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { checkReadiness } from '../src/readiness';

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
afterEach(() => {
  if (DSN_ORIGINAL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = DSN_ORIGINAL;
});

describe('el detalle de /ready', () => {
  it('la primera sonda solo alcanza a decir que no llegó', async () => {
    const pool = poolQueTarda(4000, new Error('connect ETIMEDOUT 15.229.150.166:5432'));
    const r = await checkReadiness(pool);
    const pg = r.dependencias.find((d) => d.nombre === 'postgres')!;
    expect(pg.ok).toBe(false);
    expect(pg.detalle).toBe('no respondió en 2000 ms');
  }, 15_000);

  it('la siguiente ya dice la causa, aunque haya llegado tarde', async () => {
    const pool = poolQueTarda(100, new Error('connect ETIMEDOUT 15.229.150.166:5432'));
    // La primera guarda el motivo al rechazar.
    await checkReadiness(pool);
    const r = await checkReadiness(pool);
    const pg = r.dependencias.find((d) => d.nombre === 'postgres')!;
    // Acá el error llega dentro del tope, así que se ve directo.
    expect(pg.detalle).toMatch(/ETIMEDOUT/);
  }, 15_000);

  it('un fallo lento termina apareciendo en la sonda siguiente', async () => {
    const lento = poolQueTarda(2500, new Error('getaddrinfo ENOTFOUND aws-0-sa-east-1.pooler.supabase.com'));
    // La primera se corta en el tope: el error todavía viene en camino.
    const primera = await checkReadiness(lento);
    expect(primera.dependencias[0].ok).toBe(false);
    expect(primera.dependencias[0].detalle).toMatch(/no respondió en 2000 ms/);
    expect(primera.dependencias[0].detalle).not.toMatch(/ENOTFOUND/);

    // Se le da tiempo a que el error lento aterrice.
    await new Promise((r) => setTimeout(r, 800));
    const segunda = await checkReadiness(lento);
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
    await sonda(roto);
    // 1 · el motivo quedó guardado: si esto no pasa, lo de abajo no prueba nada.
    const conMotivo = await sonda(roto);
    expect(conMotivo.dependencias[0].detalle).toMatch(/ENOTFOUND/);

    // 2 · anda: el mapa se limpia.
    const sano = poolQueTarda(5);
    const verde = await sonda(sano);
    expect(verde.dependencias[0].ok).toBe(true);
    expect(verde.dependencias[0].detalle).toBeUndefined();

    // 3 · y el fallo siguiente, sin causa propia, NO nombra el de antes.
    const mudo = poolQueTarda(4000);
    const otraVez = await sonda(mudo);
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
    const r = await checkReadiness(pool);
    const pg = r.dependencias.find((d) => d.nombre === 'postgres')!;
    expect(pg.ok).toBe(false);
    // Un timeout se ve idéntico venga del puerto que venga. Sin esto, desde
    // afuera no hay forma de saber si el contenedor tomó el valor nuevo.
    expect(pg.detalle).toContain('puerto 6543');
  });

  it('NO publica host, usuario ni contraseña', async () => {
    process.env.DATABASE_URL = 'postgres://elusuario:lacontrasena@db.interna.cl:5432/postgres';
    const pool = { query: () => new Promise(() => {}) } as unknown as Pool;
    const r = await checkReadiness(pool);
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
    const r = await checkReadiness(pool);
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
    const pg = (await checkReadiness(pool)).dependencias.find((d) => d.nombre === 'postgres')!;
    expect(pg.detalle).toContain('puerto 6543');
    expect(pg.detalle).toContain('sale a internet: sí');
  });

  it('443 tampoco: no tiene salida y el puerto no tiene nada que ver', async () => {
    process.env.SUPABASE_URL = 'https://proyecto.supabase.co';
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:6543/postgres';
    globalThis.fetch = (async () => {
      throw new Error('connect ETIMEDOUT');
    }) as unknown as typeof fetch;
    const pool = { query: () => new Promise(() => {}) } as unknown as Pool;
    const pg = (await checkReadiness(pool)).dependencias.find((d) => d.nombre === 'postgres')!;
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
    const r = await checkReadiness(pool);
    expect(r.dependencias.find((d) => d.nombre === 'postgres')!.ok).toBe(true);
    // Una sonda de diagnóstico que llama afuera en cada chequeo de salud es
    // tráfico y latencia por nada. Solo corre cuando ya hay un problema.
    expect(llamadas).toBe(0);
  });

  it('sin SUPABASE_URL no inventa una conclusión', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:5432/postgres';
    const pool = { query: () => new Promise(() => {}) } as unknown as Pool;
    const pg = (await checkReadiness(pool)).dependencias.find((d) => d.nombre === 'postgres')!;
    expect(pg.detalle).toContain('puerto 5432');
    expect(pg.detalle).not.toContain('sale a internet');
  });
});

/**
 * El tope agotado no es un corte de red (#852).
 *
 * El discriminador de #241 tiene tres lecturas y antes solo publicaba dos: el
 * `AbortError` del propio tope entraba por el mismo `catch` que un
 * `ECONNREFUSED` y salía como «sale a internet: NO (timeout)». Un NO rotundo
 * sobre algo que nunca se comprobó.
 *
 * Y las dos sondas compartían el tope de 2 s, así que un arranque en frío
 * —que hace tardar a las dos por el mismo motivo— producía exactamente la
 * lectura «no tiene salida», la que manda a mirar la red del VPS, el firewall
 * y Cloudflare. Staging contestó eso con `ms: 2003` y veinte segundos después
 * estaba todo en verde; con ese detalle en la mano se le dijo al dueño que la
 * base estaba caída, y no lo estaba.
 *
 * Estas pruebas tardan porque ejercitan los topes de verdad. Con temporizador
 * falso no probarían nada de lo que falló: lo que falló fue la relación entre
 * dos topes reales.
 */
describe('tope agotado vs. sin salida: dos cosas distintas (#852)', () => {
  const FETCH_REAL = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = FETCH_REAL;
    delete process.env.SUPABASE_URL;
  });

  /**
   * Un `fetch` que tarda `ms` y que OBEDECE el `signal`, como undici.
   *
   * Lo segundo es la mitad que importa, y se aprendió al revés: la primera
   * versión de este doble resolvía a los 3 s ignorando el `signal`, así que
   * «443 contesta pasado el tope de la base» pasaba igual con el tope
   * compartido de 2 s — la prueba del tope propio no probaba el tope. Un doble
   * que no aborta convierte cualquier tope en ninguno.
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

  it('las dos sondas agotan su tope a la vez: no concluye nada sobre la red', async () => {
    process.env.SUPABASE_URL = 'https://proyecto.supabase.co';
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:6543/postgres';
    // Nunca llega a contestar: solo lo corta el tope. Es el arranque en frío.
    globalThis.fetch = fetchQueTarda(60_000);
    // El pooler frío no contesta y el 443 tampoco: el caso que mentía.
    const pool = { query: () => new Promise(() => {}) } as unknown as Pool;

    const r = await checkReadiness(pool);
    const pg = r.dependencias.find((d) => d.nombre === 'postgres')!;

    expect(pg.detalle).toContain('no se pudo comprobar');
    expect(pg.detalle).toContain('no concluyente');
    // Esto es lo que se arregló: antes decía justo esto, y era falso.
    expect(pg.detalle).not.toContain('sale a internet: NO');
    // Y lo que NO se aflojó: el fallo de la base sigue siendo un fallo. Si
    // esto se pusiera en verde, la sonda de diagnóstico habría empezado a
    // decidir la salud y un corte real se publicaría como instancia lista.
    expect(pg.ok).toBe(false);
    expect(r.status).toBe('degraded');
  }, 20_000);

  it('un corte de verdad sigue siendo un NO: el ruido no se cambió por silencio', async () => {
    process.env.SUPABASE_URL = 'https://proyecto.supabase.co';
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:6543/postgres';
    // Sin salida, la pila de red contesta rápido y con nombre propio: eso sí
    // concluye. Es la mitad de la distinción que la otra prueba no cubre.
    globalThis.fetch = (async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' });
    }) as unknown as typeof fetch;
    const pool = { query: () => new Promise(() => {}) } as unknown as Pool;

    const pg = (await checkReadiness(pool)).dependencias.find((d) => d.nombre === 'postgres')!;
    expect(pg.detalle).toContain('sale a internet: NO');
    expect(pg.detalle).toContain('ECONNREFUSED');
    expect(pg.detalle).not.toContain('no se pudo comprobar');
  }, 20_000);

  it('la sonda de salida tiene más tope que la base: alcanza a contestar y distingue', async () => {
    process.env.SUPABASE_URL = 'https://proyecto.supabase.co';
    process.env.DATABASE_URL = 'postgres://u:p@db.ejemplo.com:6543/postgres';
    // 443 contesta a los 3 s: pasado el tope de la base, dentro del propio.
    // Con el tope compartido de 2 s esto se reportaba como «no tiene salida»,
    // que era la lectura más alarmante de las tres y la equivocada.
    globalThis.fetch = fetchQueTarda(3000);
    const pool = { query: () => new Promise(() => {}) } as unknown as Pool;

    const pg = (await checkReadiness(pool)).dependencias.find((d) => d.nombre === 'postgres')!;
    // La lectura útil: sale a internet, le bloquean ESE puerto.
    expect(pg.detalle).toContain('sale a internet: sí');
    expect(pg.detalle).toContain('puerto 6543');
  }, 20_000);
});

