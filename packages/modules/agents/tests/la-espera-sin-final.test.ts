import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiSdkModelPort, ESPERA_MAXIMA_MS } from '../application/models';
import { motivoDelProveedor } from '../application/motivo-del-proveedor';
import { FalloDelProveedor, esDelProveedor } from '../application/fallo-del-proveedor';
import { describirSinSugerencia } from '../application/por-que-no-sugirio';

/**
 * La espera que no terminaba nunca (#688).
 *
 * Medido el 28/09 con la llave de producción: `curl` pelado a NVIDIA, sin
 * herramientas, con el prompt «di hola», **139 s y 178 s**. La noche anterior esa
 * misma llamada tardaba 2 s. El tier gratuito se puso a encolar.
 *
 * Que el proveedor esté lento no es nuestro. Que se vea idéntico a estar roto, sí:
 * no había un solo límite de espera en ninguna capa —ni en el puerto del modelo,
 * ni en el controlador, ni en el front— así que el panel se quedaba en «Buscando
 * entre sus herramientas…» para siempre. El reporte fue «es como que no hay IA
 * conectada», cuatro veces.
 *
 * Y mientras tanto la petición retiene una conexión del pool, que con
 * DB_POOL_MAX en 6 es el camino a #673 otra vez.
 */
describe('al proveedor se le espera, pero no para siempre (#688)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('un proveedor que no contesta se corta, y no cuelga la petición', async () => {
    // Con llave, si no la llamada falla ANTES de salir a la red —«no tiene llave
    // configurada»— y esta prueba pasaría sin probar nada. Me pasó: verifiqué al
    // revés, quité el abortSignal, y seguía en verde.
    vi.stubEnv('GLM_API_KEY', 'llave-de-mentira');
    // Un servidor de mentira que acepta y NO responde: es exactamente el caso que
    // pasó —la conexión abierta, sin error, sin datos—.
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    try {
      const inicio = Date.now();
      const error = await aiSdkModelPort('glm', 'z-ai/glm-5.3-flash')
        .generate({ prompt: 'hola', esperaMaximaMs: 300 })
        .then(() => null)
        .catch((e) => e);
      expect(error, 'la llamada tiene que cortarse, no quedarse esperando').not.toBeNull();
      expect(Date.now() - inicio).toBeLessThan(10_000);
      // Y sale marcado como del proveedor, para que se pueda explicar (#684).
      expect(esDelProveedor(error)).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  }, 20_000);

  it('el corte se explica como lo que es, no como un error cualquiera', () => {
    const d = motivoDelProveedor(FalloDelProveedor.de(new Error('The operation was aborted')), {
      provider: 'glm',
      model: 'z-ai/glm-5.3-flash',
    });
    expect(d.motivo).toBe('no_contesto_a_tiempo');
    // Reintentable: la congestión pasa. Lo contrario de «sin saldo», que pide
    // no reintentar — decirlo al revés manda a revisar una cuenta sana.
    expect(d.reintentable).toBe(true);
    expect(d.message).toMatch(/no es un problema de tu cuenta/i);
    expect(d.message).toContain('glm');
  });

  it('no se confunde con «el proveedor está caído»', () => {
    // Un abort trae textos que parecen de otra cosa. Si cayera en «desconocido»,
    // el mensaje mandaría a «revisar su estado» cuando lo que pasó es que tardó.
    for (const texto of ['aborted', 'TimeoutError: The operation was aborted', 'request timed out']) {
      expect(motivoDelProveedor(FalloDelProveedor.de(new Error(texto))).motivo).toBe('no_contesto_a_tiempo');
    }
  });

  it('la bandeja también lo dice con nombre propio', () => {
    const r = describirSinSugerencia('no_contesto_a_tiempo', { provider: 'glm' });
    expect(r.loArreglaElNegocio).toBe(false);
    expect(r.texto).toContain('glm');
    expect(r.queHacer).toMatch(/congestión/i);
  });

  it('el tope por omisión es un minuto, y se puede mover por variable', () => {
    // Un minuto para una pregunta del panel es generoso; lo normal son segundos.
    // Lo que no puede pasar es lo de hoy: tres minutos de spinner mudo.
    expect(ESPERA_MAXIMA_MS).toBeGreaterThan(5_000);
    expect(ESPERA_MAXIMA_MS).toBeLessThanOrEqual(120_000);
  });
});
