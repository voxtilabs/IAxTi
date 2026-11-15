// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { comparacionDelMes } from '../components/crm/oportunidades';

/**
 * Cómo se nombra la comparación de «Ganado» (#1346).
 *
 * El mes y el día vienen calculados en la zona del negocio desde la API; acá
 * solo se prueba que la etiqueta diga contra qué se compara, incluido el
 * borde de enero (el anterior es diciembre) y el del mes anterior más corto.
 */
const base = { esteMesClp: 0, mesAnteriorClp: 0 };

describe('la comparación del mes', () => {
  it('a mitad de mes dice el tramo del mes anterior', () => {
    expect(comparacionDelMes({ ...base, mes: 11, dia: 15, mesAnteriorCompleto: false })).toEqual({
      titulo: 'Ganado en noviembre',
      contra: 'Octubre, del 1 al 15',
    });
  });

  it('en enero compara contra diciembre', () => {
    expect(comparacionDelMes({ ...base, mes: 1, dia: 3, mesAnteriorCompleto: false }).contra).toBe('Diciembre, del 1 al 3');
  });

  it('si el mes anterior se tomó entero, lo dice', () => {
    expect(comparacionDelMes({ ...base, mes: 3, dia: 31, mesAnteriorCompleto: true }).contra).toBe('Febrero completo');
  });
});
