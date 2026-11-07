import { afterEach, describe, expect, it } from 'vitest';
import { fetchMediaBytes } from '../application/zavu';

/**
 * Un adjunto no puede congelar la bandeja de todos (#1275).
 *
 * La descarga iba a memoria sin tope y sin plazo, DENTRO de la transacción
 * del camino de entrada, y la cola de entrada corría de a uno. Mientras un
 * archivo viajaba no entraba nada: ni los mensajes de los otros negocios, ni
 * los acuses, ni los avisos de pago. Un plano en PDF o un video de un
 * teléfono moderno paralizaba la entrada del despliegue entero.
 *
 * Lo que NO cambia y hay que cuidar: cuando el adjunto falla, el mensaje
 * **entra igual** con su metadata (`inbound.ts:179-181`). Perder el texto por
 * un adjunto sería peor, y eso ya estaba bien resuelto.
 */
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

/**
 * Un tope chico, inyectado. La primera versión usaba los 8 MB reales y
 * fabricaba búfers de ese tamaño: vitest se ahogaba reportándolos
 * (`Timeout calling "onTaskUpdate"`) y DOS de las cuatro pruebas corrían sin
 * que su resultado llegara a ninguna parte. Una prueba cuyo resultado se
 * pierde es peor que no tenerla, porque parece que está.
 */
const TOPE = 1024;

describe('la descarga de un adjunto está acotada (#1275)', () => {
  it('un archivo más grande que el tope no se baja', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(TOPE + 1), 'content-type': 'video/mp4' }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as unknown as Response) as unknown as typeof fetch;

    await expect(fetchMediaBytes('https://zavu.test/archivo', 'llave', { maxBytes: TOPE })).rejects.toThrow(/el máximo son/);
  });

  /**
   * `content-length` puede no venir, o mentir. Entonces el tope se comprueba
   * sobre los bytes de verdad: ahí ya se gastó la memoria, pero no el viaje a
   * R2 ni la fila en la base.
   */
  it('sin content-length, el tope se mide sobre los bytes reales', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        arrayBuffer: async () => new ArrayBuffer(TOPE + 1),
      }) as unknown as Response) as unknown as typeof fetch;

    await expect(fetchMediaBytes('https://zavu.test/plano.pdf', 'llave', { maxBytes: TOPE })).rejects.toThrow(/el máximo son/);
  });

  /**
   * El plazo es lo que impedía que una conexión colgada tomara la cola para
   * siempre. Se comprueba que la descarga SE PIDE con una señal de
   * vencimiento: medir el reloj real haría una prueba de veinte segundos.
   */
  it('la descarga se pide con un plazo', async () => {
    let señal: AbortSignal | undefined;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      señal = init?.signal ?? undefined;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        arrayBuffer: async () => new ArrayBuffer(1024),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await fetchMediaBytes('https://zavu.test/foto.jpg', 'llave');
    expect(señal).toBeInstanceOf(AbortSignal);
    expect(señal?.aborted).toBe(false);
  });

  it('un adjunto normal sigue bajando igual', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '2048', 'content-type': 'image/jpeg' }),
        arrayBuffer: async () => new ArrayBuffer(2048),
      }) as unknown as Response) as unknown as typeof fetch;

    const r = await fetchMediaBytes('https://zavu.test/foto.jpg', 'llave');
    expect(r.bytes.byteLength).toBe(2048);
    expect(r.contentType).toBe('image/jpeg');
  });
});
