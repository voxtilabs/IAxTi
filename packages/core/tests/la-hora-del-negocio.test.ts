import { describe, expect, it } from 'vitest';
import { diaDeSemanaEn, horaEn, TZ_POR_DEFECTO } from '../src/dias';

/**
 * La hora del negocio, no la del proceso (#1225).
 *
 * Medido en staging: el agente tenía horario 08:00–22:00 y a las 23:30 de
 * Chile dejó de contestar solo. El contenedor marcaba 02:30 —corre en UTC—, y
 * `inAutonomousHours` comparaba `now.getHours()`. O sea que «08:00 a 22:00»
 * significaba en realidad 05:00 a 19:00 de Chile, y nadie podía enterarse: no
 * hay error, solo sugerencias que se acumulan. Había 16.
 *
 * Las pruebas usan UN instante fijo y DOS zonas. Un instante con la zona del
 * proceso pasaría igual sin arreglar nada, que es exactamente cómo este
 * defecto sobrevivió.
 */
describe('la hora en la zona del negocio (#1225)', () => {
  /** 2026-11-03 02:30 UTC — las 23:30 del 2 de noviembre en Chile. */
  const instante = new Date('2026-11-03T02:30:00.000Z');

  it('el mismo instante son dos horas distintas según la zona', () => {
    expect(horaEn('UTC', instante)).toBe('02:30');
    expect(horaEn('America/Santiago', instante)).toBe('23:30');
  });

  /**
   * Y por eso el defecto importaba: 23:30 cae FUERA de 08:00–22:00 y 02:30
   * también, así que con el reloj equivocado el agente callaba igual — pero
   * por el motivo equivocado y en las horas equivocadas. A mediodía de Chile
   * la diferencia se ve al revés.
   */
  it('a las 20:00 de Chile el contenedor ya está en el día siguiente', () => {
    const tarde = new Date('2026-11-03T23:00:00.000Z'); // 20:00 en Chile
    expect(horaEn('America/Santiago', tarde)).toBe('20:00');
    expect(horaEn('UTC', tarde)).toBe('23:00');
    // Dentro de 08:00–22:00 en Chile; fuera con el reloj del contenedor.
    expect(horaEn('America/Santiago', tarde) < '22:00').toBe(true);
    expect(horaEn('UTC', tarde) < '22:00').toBe(false);
  });

  it('el día de la semana también cambia con la zona', () => {
    // Domingo 1 de noviembre, 22:00 en Chile = lunes 2, 01:00 en UTC. Un
    // horario «solo de lunes a viernes» ya estaría activo el domingo a las
    // 21:00 con el reloj del contenedor.
    //
    // La primera versión de esta prueba esperaba 6 y 0, y la aritmética estaba
    // mal mía, no el código: el 1 de noviembre de 2026 es domingo. Lo dejo
    // escrito porque es el error fácil de este tema y la prueba lo atajó.
    const domingoTarde = new Date('2026-11-02T01:00:00.000Z');
    expect(diaDeSemanaEn('America/Santiago', domingoTarde)).toBe(0); // domingo
    expect(diaDeSemanaEn('UTC', domingoTarde)).toBe(1); // ya es lunes
  });

  it('la zona por defecto es la del producto, no la del proceso', () => {
    expect(TZ_POR_DEFECTO).toBe('America/Santiago');
    expect(horaEn(undefined, instante)).toBe(horaEn('America/Santiago', instante));
  });

  it('el formato es HH:MM de dos dígitos, comparable como texto', () => {
    const temprano = new Date('2026-11-03T12:05:00.000Z'); // 09:05 en Chile
    expect(horaEn('America/Santiago', temprano)).toBe('09:05');
    // Lo que importa de los dos dígitos: `'9:05' >= '08:30'` es false.
    expect(horaEn('America/Santiago', temprano) >= '08:30').toBe(true);
  });
});
