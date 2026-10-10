import { describe, expect, it } from 'vitest';
import { usdClpRate } from '../domain/pricing';

/**
 * El tipo de cambio que factura el exceso de Meta (#575).
 *
 * Una variable vacía no es una variable ausente, y acá eso se cobra: literal.
 */
describe('el tipo de cambio con la variable en blanco (#575)', () => {
  it('cae de BILLING_USD_CLP a USD_CLP_RATE, que es lo que el `??` no hacía', () => {
    // El defecto: `Number(process.env.BILLING_USD_CLP ?? process.env.USD_CLP_RATE)`.
    // Con la primera en BLANCO, `??` la da por buena, `Number('')` es 0, y el
    // `0 > 0` mandaba al 950 de fábrica — la caída a la segunda NUNCA ocurría.
    //
    // Escenario real: el operador pone USD_CLP_RATE=1010 y deja BILLING_USD_CLP
    // en blanco. Cada factura cobra el exceso de Meta a 950 en vez de 1010.
    expect(usdClpRate({ env: { BILLING_USD_CLP: '', USD_CLP_RATE: '1010' } })).toBe(1010);
  });

  it('la principal manda cuando tiene valor', () => {
    expect(usdClpRate({ env: { BILLING_USD_CLP: '1020', USD_CLP_RATE: '1010' } })).toBe(1020);
  });

  it('sin ninguna de las dos, el 950 de siempre', () => {
    expect(usdClpRate({ env: {} })).toBe(950);
    expect(usdClpRate({ env: { BILLING_USD_CLP: '', USD_CLP_RATE: '' } })).toBe(950);
  });

  it('un valor que no es un número no se usa como cero', () => {
    // `Number('mil') === NaN` y el `>` con NaN es falso, así que el viejo
    // llegaba al 950 igual — pero callado. Ahora avisa, que es la diferencia
    // entre «está mal configurado» y «el producto cobra raro».
    const original = console.warn;
    console.warn = () => {};
    try {
      expect(usdClpRate({ env: { BILLING_USD_CLP: 'mil' } })).toBe(950);
    } finally {
      console.warn = original;
    }
  });
});
