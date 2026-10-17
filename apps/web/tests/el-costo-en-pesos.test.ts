import { describe, expect, it } from 'vitest';
import { costoMostrable } from '../lib/reportes';

/**
 * El costo, en pesos y diciendo lo que no se pudo convertir (#796).
 *
 * Los tres estados se muestran distinto a propósito, y el tercero es el que
 * importa: si un monto con días sin tipo de cambio se mostrara como si
 * estuviera completo, saldría más bajo que el real y nada avisaría.
 */
describe('el costo que se muestra', () => {
  it('en pesos, con el dólar en la explicación para cuadrar la factura', () => {
    const r = costoMostrable({ usd: 12.4, clp: 11_809, diasSinCambio: 0 }, 2);
    // El formato de es-CL usa punto como separador de miles.
    expect(r.valor.replace(/ /g, ' ')).toContain('11.809');
    expect(r.nota).toContain('USD 12.40');
    expect(r.nota).toContain('dólar observado de cada día');
  });

  it('sin gasto muestra un guion, no un cero en pesos', () => {
    expect(costoMostrable({ usd: 0, clp: 0, diasSinCambio: 0 }, 2)).toEqual({ valor: '—', nota: '' });
  });

  it('sin NINGÚN tipo de cambio muestra dólares y dice por qué', () => {
    const r = costoMostrable({ usd: 5, clp: null, diasSinCambio: 1 }, 3);
    expect(r.valor).toBe('USD 5.000');
    expect(r.nota).toContain('Sin tipo de cambio');
    expect(r.nota).toContain('otra fecha');
  });

  it('con algunos días sin cambio avisa que el monto está INCOMPLETO', () => {
    // Lo que no puede pasar: mostrar $1.800 como si fueran los 7 USD.
    const r = costoMostrable({ usd: 7, clp: 1_800, diasSinCambio: 1 }, 2);
    expect(r.valor.replace(/ /g, ' ')).toContain('1.800');
    expect(r.nota).toContain('incompleto');
    expect(r.nota).toContain('1 día');
  });

  it('sin el campo no inventa nada: la API vieja del rollout', () => {
    expect(costoMostrable(undefined, 2)).toEqual({ valor: '', nota: '' });
  });

  it('singular y plural, que es lo que se lee', () => {
    expect(costoMostrable({ usd: 7, clp: 1_800, diasSinCambio: 3 }, 2).nota).toContain('3 días');
    expect(costoMostrable({ usd: 7, clp: null, diasSinCambio: 2 }, 2).nota).toContain('esos días');
  });
});
