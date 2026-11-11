import { afterEach, describe, expect, it } from 'vitest';
import { fetchMediaBytes, llevaCredencial } from '../application/zavu';

/**
 * La llave del proveedor no se le manda a cualquier host (#1335).
 *
 * `fetchMediaBytes` bajaba los adjuntos entrantes con
 * `Authorization: Bearer <llave de la cuenta>` hacia la URL que viniera en el
 * payload del webhook. La firma del webhook prueba que el payload es de
 * Zavu; NO prueba que cada URL de adentro apunte a Zavu. Un adjunto de
 * Instagram llega con la CDN de Meta (`lookaside.fbsbx.com`,
 * `*.fbcdn.net`), y con la cabecera de siempre la llave del negocio terminaba
 * en servidores de Meta en cada foto — y en manos de cualquiera si algún día
 * una URL ajena se colaba en el payload.
 *
 * `llevaCredencial` es la cerradura: la llave viaja SOLO por HTTPS y SOLO a un
 * host del dominio del proveedor. Las primeras pruebas miran la función sola;
 * las que siguen miran la PETICIÓN que sale por `fetch`, que es lo que el
 * criterio del issue pide medir — el valor de retorno de un cálculo no
 * asegura nada sobre la cabecera que se mandó.
 */

/**
 * El valor de `authorization` en un `init.headers` que puede llegar de tres
 * formas: ausente, objeto plano o `Headers`. Mirarlo con
 * `init.headers.Authorization` a secas funciona hasta que cambia la forma —y la
 * forma la elige quien arma la petición, no esta prueba. Insensible a
 * mayúsculas: `Authorization` y `authorization` son la misma cabecera.
 */
function autorizacionDe(init?: RequestInit): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get('authorization') ?? undefined;
  if (Array.isArray(headers)) {
    for (const par of headers) {
      if (String(par[0]).toLowerCase() === 'authorization') return String(par[1]);
    }
    return undefined;
  }
  if (typeof headers === 'object') {
    for (const [nombre, valor] of Object.entries(headers as Record<string, string>)) {
      if (nombre.toLowerCase() === 'authorization') return valor;
    }
  }
  return undefined;
}

/** Un `fetch` que solo mira lo que sale y siempre contesta un adjunto chico. */
function espiar() {
  const pedidos: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    pedidos.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => new ArrayBuffer(16),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { pedidos, fetchImpl };
}

/**
 * La base por omisión de Zavu sale del entorno (`ZAVU_API_BASE`). Esta prueba
 * la quiere SIN definir para probar el default; se guarda la que había para
 * devolverla y no ensuciar a las suites que corren después sobre el mismo
 * proceso.
 */
const BASE_QUE_HABIA = process.env.ZAVU_API_BASE;
afterEach(() => {
  if (BASE_QUE_HABIA === undefined) delete process.env.ZAVU_API_BASE;
  else process.env.ZAVU_API_BASE = BASE_QUE_HABIA;
});

const BASE_ZAVU = 'https://api.zavu.dev/v1';

describe('llevaCredencial: a qué URLs puede ir la llave (#1335)', () => {
  it('el dominio del proveedor sí: el host del API, un subdominio y el pelado', () => {
    // No se sabe desde el código en qué host sirve Zavu sus adjuntos —las
    // fixtures traen tanto `api.` como `cdn.`—, así que se admite el dominio
    // entero. Un tercero no compra `zavu.dev` para robar una llave.
    expect(llevaCredencial('https://api.zavu.dev/x', BASE_ZAVU)).toBe(true);
    expect(llevaCredencial('https://cdn.zavu.dev/m/1.jpg', BASE_ZAVU)).toBe(true);
    expect(llevaCredencial('https://zavu.dev/a', BASE_ZAVU)).toBe(true);
  });

  it('las CDN de Meta no: ahí era donde la llave se perdía en cada foto', () => {
    expect(llevaCredencial('https://lookaside.fbsbx.com/x', BASE_ZAVU)).toBe(false);
    expect(llevaCredencial('https://scontent.fbcdn.net/x', BASE_ZAVU)).toBe(false);
  });

  it('un host que EMPIEZA igual pero es otro no la recibe', () => {
    // `https://api.zavu.dev.atacante.com` empieza con el origin del API como
    // texto: comparar con `startsWith` lo dejaría pasar como bueno.
    expect(llevaCredencial('https://api.zavu.dev.atacante.com/x', BASE_ZAVU)).toBe(false);
  });

  it('un dominio que TERMINA igual sin el punto no alcanza', () => {
    // `malozavu.dev` termina en `zavu.dev` como texto; el punto que separa las
    // etiquetas es justamente la línea que esto no puede cruzar.
    expect(llevaCredencial('https://malozavu.dev/x', BASE_ZAVU)).toBe(false);
  });

  it('sin https no: la llave no viaja en claro', () => {
    expect(llevaCredencial('http://api.zavu.dev/x', BASE_ZAVU)).toBe(false);
  });

  it('un usuario en la URL engaña al ojo, no al hostname', () => {
    // `https://api.zavu.dev@atacante.com/x` se LEE como el host del proveedor,
    // pero lo que va antes de la `@` es usuario: el host real es `atacante.com`,
    // y ahí es donde iría la llave.
    expect(llevaCredencial('https://api.zavu.dev@atacante.com/x', BASE_ZAVU)).toBe(false);
  });

  it('una URL que no parsea no recibe nada', () => {
    expect(llevaCredencial('nada', BASE_ZAVU)).toBe(false);
  });
});

describe('llevaCredencial con un dominio de dos etiquetas (#1317)', () => {
  const BASE_ZERNIO = 'https://zernio.com/api/v1';

  it('el host del proveedor sí', () => {
    // Zernio sirve sus adjuntos de WhatsApp en su propio host, bajo /v1.
    expect(llevaCredencial('https://zernio.com/v1/whatsapp/media/1', BASE_ZERNIO)).toBe(true);
  });

  it('la etiqueta pelada del TLD no: el dominio es `zernio.com`, no `com`', () => {
    // Con dos etiquetas el dominio es el host entero. Recortarle la primera
    // igual que a `api.zavu.dev` dejaría confiando en `com`: eso le entrega la
    // llave a todo el que compre cualquier dominio `.com`.
    expect(llevaCredencial('https://com/x', BASE_ZERNIO)).toBe(false);
    expect(llevaCredencial('https://otro.com/x', BASE_ZERNIO)).toBe(false);
  });
});

describe('fetchMediaBytes manda la llave según el host (#1335)', () => {
  it('a la CDN de Meta la baja SIN authorization', async () => {
    const { pedidos, fetchImpl } = espiar();
    await fetchMediaBytes('https://lookaside.fbsbx.com/m/foto.jpg', 'zv_llave_de_prueba', {
      fetchImpl,
      apiBase: BASE_ZAVU,
    });

    expect(pedidos).toHaveLength(1);
    // La cabecera tiene que faltar, no llegar vacía: una cabecera vacía es una
    // cabecera que viaja igual.
    expect(autorizacionDe(pedidos[0].init)).toBeUndefined();
  });

  it('al host del proveedor la baja CON la llave exacta', async () => {
    const { pedidos, fetchImpl } = espiar();
    await fetchMediaBytes('https://api.zavu.dev/v1/media/foto.jpg', 'zv_llave_de_prueba', {
      fetchImpl,
      apiBase: BASE_ZAVU,
    });

    expect(pedidos).toHaveLength(1);
    expect(autorizacionDe(pedidos[0].init)).toBe('Bearer zv_llave_de_prueba');
  });

  it('sin apiBase usa baseDeZavu: cdn.zavu.dev sigue siendo del proveedor', async () => {
    // El por-omisión también pasa por la cerradura, y con el default la CDN
    // propia de Zavu sigue llevando la llave: recortar la llave de las CDN del
    // proveedor rompería los adjuntos que hoy funcionan.
    delete process.env.ZAVU_API_BASE;
    const { pedidos, fetchImpl } = espiar();

    await fetchMediaBytes('https://cdn.zavu.dev/m/foto.jpg', 'zv_llave_de_prueba', { fetchImpl });

    expect(pedidos).toHaveLength(1);
    expect(autorizacionDe(pedidos[0].init)).toBe('Bearer zv_llave_de_prueba');
  });
});