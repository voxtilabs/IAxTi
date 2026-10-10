import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cierreDeLaVentana, isWithinWindow, VENTANA_HORAS } from '../domain/state';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * La lista de canales se LEE del archivo de `channels`, no se importa.
 *
 * Importarla obligaría a que `conversations` dependa de `channels`, y eso es
 * mover la arquitectura para tener una prueba — la regla dice que un módulo
 * entra a otro solo por su contrato, y este dato no es algo que `conversations`
 * necesite en producción. Leer el archivo es lo que ya hacen las otras guardas
 * de este repo, y falla igual de fuerte si la lista cambia.
 *
 * Se quitan los comentarios antes de buscar: los comentarios de este repo
 * mencionan canales todo el tiempo y ya hicieron pasar por verde a cuatro
 * guardas distintas.
 */
function canalesQueExisten(): string[] {
  const ruta = join(__dirname, '..', '..', 'channels', 'domain', 'port.ts');
  const fuente = fuenteLimpia(readFileSync(ruta, 'utf8'))
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  const m = /export const CHANNEL_KINDS = \[([^\]]+)\]/.exec(fuente);
  if (!m) throw new Error('No se pudo leer CHANNEL_KINDS de channels/domain/port.ts');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/**
 * La ventana de 24 h es la única puerta entre quien atiende y un mensaje que
 * WhatsApp va a rechazar (#639). La llaman la API al responder, el worker antes
 * de despachar y el motor de automatizaciones — o sea que un error acá apaga el
 * resguardo en los tres lugares a la vez.
 *
 * Lo que motivó esto: once mensajes escritos a mano salieron con la ventana
 * cerrada y volvieron con el código 131047 de Meta. El SPEC §11 promete que «la
 * bandeja lo muestra y bloquea; la API lo rechaza aunque la UI falle», y no
 * pasó ninguna de las dos.
 */

const HACE = (horas: number) => new Date(Date.now() - horas * 60 * 60 * 1000);

describe('ante la duda, cerrada (#639)', () => {
  it('un canal DESCONOCIDO se trata como cerrada, no como abierta', () => {
    // Esto devolvía `true`. `VENTANA_HORAS['loquesea']` es `undefined`, y el
    // código lo trataba igual que el `null` de «este canal no tiene ventana».
    // Son cosas distintas: `null` es una decisión escrita, `undefined` es no
    // saber. Un nombre de canal con otra capitalización, un canal nuevo sin su
    // fila, un valor viejo en la base: cualquiera apagaba el resguardo.
    expect(isWithinWindow('telegram', new Date())).toBe(false);
    expect(isWithinWindow('WhatsApp', new Date())).toBe(false);
    expect(isWithinWindow('', new Date())).toBe(false);
    expect(isWithinWindow('whatsapp_business', new Date())).toBe(false);
  });

  it('negarse es recuperable y dejar pasar no: por eso el defecto es cerrar', () => {
    // Con un canal desconocido y un entrante de hace un minuto —el caso más
    // favorable posible— igual se niega. No es rigor de más: se manda una
    // plantilla aprobada y la conversación se reabre; el camino de vuelta
    // existe. El otro camino gasta el intento y no avisa.
    expect(isWithinWindow('canal-que-no-existe', HACE(0.01))).toBe(false);
  });
});

describe('la tabla cubre TODOS los canales que existen', () => {
  /**
   * Esta es la contracara de fallar cerrada, y hay que decirla: desde que un
   * canal desconocido se niega, **olvidarse de agregar uno a la tabla ya no es
   * un descuido, es un canal que no puede enviar**. Y en silencio, que es lo
   * peor: la pantalla ofrece plantillas, la API rechaza, y nadie relaciona eso
   * con un renglón que falta.
   *
   * Antes de #639 el olvido no se notaba —el canal nuevo pasaba como «sin
   * ventana»—, así que esta guarda no hacía falta. Ahora sí.
   */
  it('cada ChannelKind tiene su entrada, o ese canal no puede enviar nada', () => {
    const faltan = canalesQueExisten().filter((k) => !(k in VENTANA_HORAS));
    expect(
      faltan,
      'Estos canales existen y no están en VENTANA_HORAS. Desde #639 eso NO es ' +
        'un defecto cosmético: isWithinWindow los trata como cerrados, la API ' +
        'rechaza todo envío y quien atiende no puede escribir por ese canal:\n  ' +
        faltan.join('\n  '),
    ).toEqual([]);
  });

  it('y la tabla no inventa canales que no existen', () => {
    // Un canal de más es un renglón que nadie mantiene y que miente sobre qué
    // soporta el producto.
    const existen = canalesQueExisten();
    const sobran = Object.keys(VENTANA_HORAS).filter((k) => !existen.includes(k));
    expect(sobran).toEqual([]);
  });
});

describe('los canales que sí conocemos', () => {
  it('webchat y simulador siempre dejan responder: el canal es nuestro', () => {
    for (const canal of ['webchat', 'simulador']) {
      expect(VENTANA_HORAS[canal], canal).toBeNull();
      expect(isWithinWindow(canal, null), canal).toBe(true);
      expect(isWithinWindow(canal, HACE(500)), canal).toBe(true);
    }
  });

  it('en los de Meta manda el último entrante', () => {
    for (const canal of ['whatsapp', 'instagram', 'messenger']) {
      expect(isWithinWindow(canal, HACE(1)), canal).toBe(true);
      expect(isWithinWindow(canal, HACE(23.9)), canal).toBe(true);
      expect(isWithinWindow(canal, HACE(25)), canal).toBe(false);
      // Nunca escribió: no hay ventana que abrir.
      expect(isWithinWindow(canal, null), canal).toBe(false);
    }
  });

  it('cada canal de Meta es su propia regla, aunque hoy las tres den 24', () => {
    // Están separadas a propósito: si Meta mueve una, se toca la tabla y no
    // diez `if`. La prueba existe para que nadie las junte "simplificando".
    expect(VENTANA_HORAS.whatsapp).toBe(24);
    expect(VENTANA_HORAS.instagram).toBe(24);
    expect(VENTANA_HORAS.messenger).toBe(24);
  });
});

describe('cuándo se cierra', () => {
  it('sale del mismo dato que el booleano, para que la etiqueta no lo recalcule', () => {
    const entrante = HACE(2);
    const cierre = cierreDeLaVentana('whatsapp', entrante)!;
    expect(cierre.getTime()).toBe(entrante.getTime() + 24 * 60 * 60 * 1000);
    // Coherentes entre sí: si el cierre ya pasó, la ventana está cerrada.
    expect(isWithinWindow('whatsapp', entrante)).toBe(cierre.getTime() > Date.now());
  });

  it('sin ventana, sin entrante o con un canal desconocido no hay reloj que mostrar', () => {
    expect(cierreDeLaVentana('webchat', new Date())).toBeNull();
    expect(cierreDeLaVentana('whatsapp', null)).toBeNull();
    expect(cierreDeLaVentana('telegram', new Date())).toBeNull();
  });
});
