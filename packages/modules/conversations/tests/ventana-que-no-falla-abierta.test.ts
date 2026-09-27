import { describe, expect, it } from 'vitest';
import { cierreDeLaVentana, isWithinWindow, VENTANA_HORAS } from '../domain/state';

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
