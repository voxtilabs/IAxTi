import { describe, expect, it, vi } from 'vitest';
import { enteroDeEntorno, textoDeEntorno, entornoDesplegado, esProduccion } from '../src/entorno';

// `Number(process.env.X ?? 120)` se lee bien y falla mal. Lo que sigue es
// cada forma en que falla, con el nombre de lo que rompía.

describe('enteroDeEntorno', () => {
  it('sin la variable usa el por-defecto y no se queja', () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(enteroDeEntorno('NO_EXISTE', 3000, { env: {} })).toBe(3000);
    // No estar configurada NO es un error: es lo normal.
    expect(avisos).not.toHaveBeenCalled();
    avisos.mockRestore();
  });

  it('la cadena VACÍA es el caso que muerde, y `??` no la atrapa', () => {
    // Number('') es 0, y `??` solo cubre null y undefined. Dejar una
    // variable en blanco en el panel es la forma normal de "desactivarla".
    const enBlanco: string | undefined = '';
    expect(Number(enBlanco ?? 3000)).toBe(0); // lo que pasaba antes
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(enteroDeEntorno('PORT', 3000, { env: { PORT: '' } })).toBe(3000);
    expect(enteroDeEntorno('PORT', 3000, { env: { PORT: '   ' } })).toBe(3000);
    // En blanco es "no configurada", no "configurada mal": no avisa.
    expect(avisos).not.toHaveBeenCalled();
    avisos.mockRestore();
  });

  it('basura cae al por-defecto Y LO DICE', () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(enteroDeEntorno('PORT', 3000, { env: { PORT: 'tres mil' } })).toBe(3000);
    // Callarse sería repetir el problema en otro lugar: alguien puso un
    // valor con intención y no está pasando nada de lo que espera.
    expect(avisos).toHaveBeenCalledOnce();
    const texto = String(avisos.mock.calls[0][0]);
    expect(texto).toContain('PORT="tres mil"');
    expect(texto).toContain('Se usa 3000');
    avisos.mockRestore();
  });

  it('un cero explícito tampoco pasa: es el que hace listen() al azar', () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(enteroDeEntorno('PORT', 3000, { env: { PORT: '0' } })).toBe(3000);
    expect(enteroDeEntorno('WHATSAPP_MSGS_PER_SECOND', 10, { env: { WHATSAPP_MSGS_PER_SECOND: '0' } })).toBe(10);
    expect(avisos).toHaveBeenCalledTimes(2);
    avisos.mockRestore();
  });

  it('negativos y decimales raros tampoco', () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(enteroDeEntorno('X', 5, { env: { X: '-1' } })).toBe(5);
    expect(enteroDeEntorno('X', 5, { env: { X: 'NaN' } })).toBe(5);
    expect(enteroDeEntorno('X', 5, { env: { X: 'Infinity' } })).toBe(5);
    avisos.mockRestore();
  });

  it('un valor bueno pasa tal cual', () => {
    expect(enteroDeEntorno('PORT', 3000, { env: { PORT: '8080' } })).toBe(8080);
    // Y `min: 0` para los que sí aceptan cero con sentido (una pausa de 0 ms
    // es "sin pausa", y eso es una configuración válida).
    expect(enteroDeEntorno('PAUSA', 4000, { env: { PAUSA: '0' }, min: 0 })).toBe(0);
  });
});

describe('textos del entorno (#575)', () => {
  it('ausente y EN BLANCO son lo mismo: cae al por-defecto', () => {
    // Las dos entradas se prueban por separado a propósito: `??` atrapa la
    // primera y no la segunda, y esa diferencia es el issue entero.
    expect(textoDeEntorno('X', 'defecto', { env: {} })).toBe('defecto');
    expect(textoDeEntorno('X', 'defecto', { env: { X: '' } })).toBe('defecto');
    expect(textoDeEntorno('X', 'defecto', { env: { X: '   ' } })).toBe('defecto');
  });

  it('un valor de verdad llega limpio', () => {
    expect(textoDeEntorno('X', 'defecto', { env: { X: 'https://api.iaxti.cl' } })).toBe(
      'https://api.iaxti.cl',
    );
    // Los espacios de los costados se van: pegar un valor en un panel los trae,
    // y una URL con un espacio al final no es la misma URL.
    expect(textoDeEntorno('X', 'd', { env: { X: '  valor  ' } })).toBe('valor');
  });

  it('no avisa por una variable sin configurar: avisar de lo normal apaga los avisos', () => {
    const avisos: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => avisos.push(m);
    try {
      textoDeEntorno('X', 'd', { env: {} });
      textoDeEntorno('X', 'd', { env: { X: '' } });
    } finally {
      console.warn = original;
    }
    expect(avisos).toEqual([]);
  });
});

describe('IAXTI_ENV es distinta: en blanco SÍ avisa (#575)', () => {
  it('ausente no avisa; en BLANCO sí', () => {
    // De `IAXTI_ENV` cuelgan el modo de los pagos, el environment de Sentry y la
    // comprobación de aislamiento. Caer al por-defecto en silencio es cómo un
    // ambiente mal configurado se hace pasar por desarrollo.
    const avisos: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => avisos.push(m);
    try {
      expect(entornoDesplegado({ env: {} })).toBe('development');
      expect(avisos, 'avisó por una variable que simplemente no está').toEqual([]);
      expect(entornoDesplegado({ env: { IAXTI_ENV: '' } })).toBe('development');
      expect(avisos).toHaveLength(1);
      expect(avisos[0]).toMatch(/IAXTI_ENV está en BLANCO/);
    } finally {
      console.warn = original;
    }
  });

  it('esProduccion es falso con la variable en blanco, que es lo restrictivo', () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      expect(esProduccion({ env: { IAXTI_ENV: 'production' } })).toBe(true);
      expect(esProduccion({ env: { IAXTI_ENV: '' } })).toBe(false);
      expect(esProduccion({ env: {} })).toBe(false);
    } finally {
      console.warn = original;
    }
  });
});
