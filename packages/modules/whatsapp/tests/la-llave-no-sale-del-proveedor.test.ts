import { describe, expect, it } from 'vitest';
import { fetchMediaBytes, llevaCredencial } from '../application/media';
import { ZERNIO_API_BASE_DEFAULT } from '../application/zernio-base';

/**
 * La llave del proveedor no se le manda a cualquier host (#1335).
 *
 * `fetchMediaBytes` baja los adjuntos entrantes desde la URL que viene en el
 * payload del webhook. La firma del webhook prueba que el payload es del
 * proveedor; NO prueba que cada URL de adentro apunte a él. Un adjunto de
 * Instagram llega con la CDN de Meta (`lookaside.fbsbx.com`,
 * `*.fbcdn.net`), y con la cabecera de siempre la llave del negocio terminaba
 * en servidores de Meta en cada foto — y en manos de cualquiera si algún día
 * una URL ajena se colaba en el payload.
 *
 * `llevaCredencial` es la cerradura: la llave viaja SOLO por HTTPS y SOLO a un
 * host del dominio del proveedor — Zernio desde #1339, que sirve sus adjuntos
 * en su propio dominio. Las primeras pruebas miran la función sola; las que
 * siguen miran la PETICIÓN que sale por `fetch`, que es lo que el criterio del
 * issue pide medir — el valor de retorno de un cálculo no asegura nada sobre
 * la cabecera que se mandó.
 *
 * Y la `apiBase` la trae quien llama (#1339): sin ella la función no adivina
 * un dominio de archivo, FALLA CERRADO — sin llave.
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
 * La base real de Zernio tiene dos etiquetas (`zernio.com`); el primer
 * describe usa una de TRES (`api.zernio.com`) para probar la otra rama de la
 * cerradura, porque el código tiene que aguantar a un proveedor que sirva sus
 * adjuntos desde un subdominio del API.
 */
const BASE_ZERNIO = ZERNIO_API_BASE_DEFAULT;
const BASE_ZERNIO_TRES_ETIQUETAS = 'https://api.zernio.com';

describe('llevaCredencial: a qué URLs puede ir la llave (#1335)', () => {
  it('el dominio del proveedor sí: el host del API, un subdominio y el pelado', () => {
    // No se sabe desde el código en qué host sirve Zernio sus adjuntos, así
    // que se admite el dominio entero. Un tercero no compra `zernio.com`
    // para robar una llave.
    expect(llevaCredencial('https://api.zernio.com/x', BASE_ZERNIO_TRES_ETIQUETAS)).toBe(true);
    expect(llevaCredencial('https://cdn.zernio.com/m/1.jpg', BASE_ZERNIO_TRES_ETIQUETAS)).toBe(true);
    expect(llevaCredencial('https://zernio.com/a', BASE_ZERNIO_TRES_ETIQUETAS)).toBe(true);
  });

  it('las CDN de Meta no: ahí era donde la llave se perdía en cada foto', () => {
    // Instagram y Messenger también van por canales, y sus adjuntos salen de
    // las CDN de Meta aunque el webhook sea de Zernio.
    expect(llevaCredencial('https://lookaside.fbsbx.com/x', BASE_ZERNIO)).toBe(false);
    expect(llevaCredencial('https://scontent.fbcdn.net/x', BASE_ZERNIO)).toBe(false);
  });

  it('un host que EMPIEZA igual pero es otro no la recibe', () => {
    // `https://api.zernio.com.atacante.com` empieza con el origin del API como
    // texto: comparar con `startsWith` lo dejaría pasar como bueno.
    expect(llevaCredencial('https://api.zernio.com.atacante.com/x', BASE_ZERNIO_TRES_ETIQUETAS)).toBe(false);
  });

  it('un dominio que TERMINA igual sin el punto no alcanza', () => {
    // `malozernio.com` termina en `zernio.com` como texto; el punto que separa
    // las etiquetas es justamente la línea que esto no puede cruzar.
    expect(llevaCredencial('https://malozernio.com/x', BASE_ZERNIO)).toBe(false);
  });

  it('sin https no: la llave no viaja en claro', () => {
    expect(llevaCredencial('http://zernio.com/x', BASE_ZERNIO)).toBe(false);
  });

  it('un usuario en la URL engaña al ojo, no al hostname', () => {
    // `https://zernio.com@atacante.com/x` se LEE como el host del proveedor,
    // pero lo que va antes de la `@` es usuario: el host real es `atacante.com`,
    // y ahí es donde iría la llave.
    expect(llevaCredencial('https://zernio.com@atacante.com/x', BASE_ZERNIO)).toBe(false);
  });

  it('una URL que no parsea no recibe nada', () => {
    expect(llevaCredencial('nada', BASE_ZERNIO)).toBe(false);
  });
});

describe('llevaCredencial con un dominio de dos etiquetas', () => {
  it('el host del proveedor sí', () => {
    // Zernio sirve sus adjuntos de WhatsApp en su propio host, bajo /api/v1.
    expect(llevaCredencial('https://zernio.com/api/v1/whatsapp/media/1', BASE_ZERNIO)).toBe(true);
  });

  it('la etiqueta pelada del TLD no: el dominio es `zernio.com`, no `com`', () => {
    // Con dos etiquetas el dominio es el host entero. Recortarle la primera
    // igual que a `api.zernio.com` dejaría confiando en `com`: eso le entrega
    // la llave a todo el que compre cualquier dominio `.com`.
    expect(llevaCredencial('https://com/x', BASE_ZERNIO)).toBe(false);
    expect(llevaCredencial('https://otro.com/x', BASE_ZERNIO)).toBe(false);
  });

  it('sin apiBase no hay dominio en quién confiar: FALLA CERRADO (#1339)', () => {
    // La apiBase la trae quien llama desde la CUENTA, y ya no hay un default
    // de archivo. Una cadena vacía no parsea, y sin dominio la llave NO viaja:
    // adivinar «zernio.com» acá sería reintroducir el default que #1339 sacó.
    expect(llevaCredencial('https://zernio.com/api/v1/whatsapp/media/1', '')).toBe(false);
  });
});

describe('fetchMediaBytes manda la llave según el host (#1335)', () => {
  it('a la CDN de Meta la baja SIN authorization', async () => {
    const { pedidos, fetchImpl } = espiar();
    await fetchMediaBytes('https://lookaside.fbsbx.com/m/foto.jpg', 'zrn_llave_de_prueba', {
      fetchImpl,
      apiBase: BASE_ZERNIO,
    });

    expect(pedidos).toHaveLength(1);
    // La cabecera tiene que faltar, no llegar vacía: una cabecera vacía es una
    // cabecera que viaja igual.
    expect(autorizacionDe(pedidos[0].init)).toBeUndefined();
  });

  it('al host del proveedor la baja CON la llave exacta', async () => {
    const { pedidos, fetchImpl } = espiar();
    await fetchMediaBytes('https://zernio.com/api/v1/whatsapp/media/foto.jpg', 'zrn_llave_de_prueba', {
      fetchImpl,
      apiBase: BASE_ZERNIO,
    });

    expect(pedidos).toHaveLength(1);
    expect(autorizacionDe(pedidos[0].init)).toBe('Bearer zrn_llave_de_prueba');
  });
});
