import { afterEach, describe, expect, it, vi } from 'vitest';
import { navDesdeLaApi, widgetsDesdeLaApi } from '../lib/nav';

/**
 * La barra lateral desaparecía sin decir nada (#679).
 *
 * Lino: «se desaparecieron los componentes… los componentes de la nav bar ya no
 * están». Medido contra staging el 27/09: la PRIMERA petición a `/` y a
 * `/bandeja` volvió con el HTML sin un solo item de menú, y de la segunda en
 * adelante con el menú completo.
 *
 * La causa era una línea que parecía inofensiva:
 *
 *   if (!res.ok) return [];
 *   } catch { return []; }
 *
 * `[]` significaba dos cosas —«no hay módulos» y «no pude preguntar»— y las dos
 * se dibujaban igual: sin barra, sin aviso, sin nada en la pantalla. Y con
 * `revalidate: 60`, que cachea también lo que no es 200, un tropiezo de un
 * segundo dejaba a todo el mundo sin menú hasta un minuto. Es lo que pasa
 * después de cada despliegue, mientras la API arranca.
 *
 * Estas pruebas miran el COMPORTAMIENTO y no el texto del archivo: la versión
 * anterior de esta suite comprobaba que el código dijera `return []`, y por eso
 * no notó nada cuando eso empezó a ser el bug.
 */

const MODULOS = [
  { id: 'crm', nav: [{ label: 'Contactos', path: '/contactos', permission: 'crm.contacts.read' }], widgets: [{ id: 'embudo', permission: 'crm.read' }] },
  { id: 'audit', nav: [{ label: 'Auditoría', path: '/ajustes/auditoria', permission: 'audit.read' }], widgets: [] },
];

function fetchQueContesta(...respuestas: Array<{ ok: boolean; status?: number }>) {
  const llamadas: Array<{ url: string; init: RequestInit & { next?: unknown } }> = [];
  let i = 0;
  const espia = vi.fn(async (url: string, init: RequestInit & { next?: unknown }) => {
    llamadas.push({ url, init });
    const r = respuestas[Math.min(i++, respuestas.length - 1)];
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 503),
      json: async () => MODULOS,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', espia);
  return llamadas;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('la barra cuando la API contesta bien', () => {
  it('trae los items, aplanados de todos los módulos', async () => {
    fetchQueContesta({ ok: true });
    const nav = await navDesdeLaApi('http://api.invalid');
    expect(nav?.map((i) => i.label)).toEqual(['Contactos', 'Auditoría']);
  });

  it('pide UNA vez y con el minuto de caché de #400', async () => {
    // Sin la caché vuelve el «Demasiadas solicitudes»: estas llamadas salen del
    // servidor del web SIN x-tenant-id, así que el limitador cae al cupo por IP
    // y las 26 páginas comparten uno solo.
    const llamadas = fetchQueContesta({ ok: true });
    await navDesdeLaApi('http://api.invalid');
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].init?.next).toEqual({ revalidate: 60 });
    expect((llamadas[0].init as { cache?: string })?.cache).toBeUndefined();
  });
});

describe('la barra cuando la API contesta mal (#679)', () => {
  it('un 503 NO se convierte en «no hay módulos»: se reintenta al tiro', async () => {
    // El problema suele durar menos que la petición. Reintentar una vez es más
    // barato que dejar a alguien sin pantalla.
    const llamadas = fetchQueContesta({ ok: false, status: 503 }, { ok: true });
    const nav = await navDesdeLaApi('http://api.invalid');
    expect(nav?.map((i) => i.label)).toEqual(['Contactos', 'Auditoría']);
    expect(llamadas).toHaveLength(2);
  });

  it('el reintento NO lee el caché: una respuesta mala guardada no se puede borrar', async () => {
    // `revalidate` cachea también lo que no es 200. Si el reintento leyera del
    // caché, leería exactamente la respuesta que acabamos de descartar.
    const llamadas = fetchQueContesta({ ok: false, status: 500 }, { ok: true });
    await navDesdeLaApi('http://api.invalid');
    expect((llamadas[1].init as { cache?: string }).cache).toBe('no-store');
  });

  it('si falla dos veces devuelve null, que NO es lista vacía', async () => {
    // Ésta es la propiedad del issue. `null` es «no pude preguntar» y lo dibuja
    // distinto: el navegador lo pide por su cuenta y, si tampoco, se avisa.
    fetchQueContesta({ ok: false, status: 502 });
    expect(await navDesdeLaApi('http://api.invalid')).toBeNull();
  });

  it('una excepción de red también es null, no lista vacía', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await navDesdeLaApi('http://api.invalid')).toBeNull();
  });

  it('después de fallar, deja de leer el caché hasta que le contesten bien', async () => {
    // Una entrada envenenada no se borra desde acá, pero sí se puede dejar de
    // creer. Sin esto, el siguiente que entra hereda el vacío del que tropezó.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caída'); }));
    await navDesdeLaApi('http://api.invalid');
    const llamadas = fetchQueContesta({ ok: true });
    await navDesdeLaApi('http://api.invalid');
    expect((llamadas[0].init as { cache?: string }).cache).toBe('no-store');
    // Y cuando vuelve a andar, vuelve la caché: desconfiar para siempre sería
    // cambiar un problema por el otro.
    const despues = fetchQueContesta({ ok: true });
    await navDesdeLaApi('http://api.invalid');
    expect(despues[0].init?.next).toEqual({ revalidate: 60 });
  });

  it('un módulo apagado sigue devolviendo lista vacía, no null', async () => {
    // La diferencia tiene que sobrevivir: «el plan no trae nada» es legítimo y
    // no lleva aviso. Si esto devolviera null, la pantalla avisaría de un
    // problema que no existe.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as unknown as Response));
    expect(await navDesdeLaApi('http://api.invalid')).toEqual([]);
  });
});

describe('los widgets del inicio no arrastran a la pantalla', () => {
  it('un fallo los deja vacíos y no rompe nada', async () => {
    // Acá sí vale degradar: el inicio sin widgets sigue siendo el inicio. Lo que
    // no puede quedar vacío en silencio es la navegación.
    fetchQueContesta({ ok: false, status: 503 });
    expect(await widgetsDesdeLaApi('http://api.invalid')).toEqual([]);
  });

  it('y con la API sana trae los de todos los módulos', async () => {
    fetchQueContesta({ ok: true });
    expect(await widgetsDesdeLaApi('http://api.invalid')).toEqual([{ id: 'embudo', permission: 'crm.read' }]);
  });
});
