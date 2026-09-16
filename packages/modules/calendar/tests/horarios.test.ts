import { describe, expect, it } from 'vitest';
import { huecosLibres, comoHora, desdeHora } from '../domain/horarios';

/**
 * La aritmética de los huecos, que es donde esto se rompe: la cita que
 * termina justo cuando empieza otra, el respiro que se come el último hueco.
 */
describe('huecos libres', () => {
  const jornada = { inicio: 540, fin: 720, duracion: 30, respiro: 0 }; // 09:00–12:00

  it('una jornada vacía se parte en horas completas', () => {
    expect(huecosLibres(jornada, []).map(comoHora)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '11:30',
    ]);
  });

  it('lo ocupado se resta, y lo que termina justo cuando empieza otro NO choca', () => {
    const libres = huecosLibres(jornada, [{ inicio: 600, fin: 630 }]).map(comoHora);
    expect(libres).not.toContain('10:00');
    // 09:30 termina a las 10:00 exactas: cabe.
    expect(libres).toContain('09:30');
    expect(libres).toContain('10:30');
  });

  it('el respiro se cuenta a los DOS lados', () => {
    const conRespiro = { ...jornada, respiro: 15 };
    const libres = huecosLibres(conRespiro, [{ inicio: 600, fin: 630 }]).map(comoHora);
    // Nada puede terminar después de 09:45 ni empezar antes de 10:45.
    expect(libres).not.toContain('09:45');
    expect(libres).not.toContain('10:30');
  });

  it('una cita que no cabe entera antes del cierre no se ofrece', () => {
    // 09:00 a 09:50 con citas de 30: solo cabe una.
    expect(huecosLibres({ inicio: 540, fin: 590, duracion: 30, respiro: 0 }, [])).toEqual([540]);
  });

  it('sin duración no hay huecos, y no revienta', () => {
    expect(huecosLibres({ ...jornada, duracion: 0 }, [])).toEqual([]);
  });

  it('la hora va y vuelve', () => {
    expect(desdeHora('09:00')).toBe(540);
    expect(comoHora(desdeHora('14:45'))).toBe('14:45');
    expect(() => desdeHora('25:00')).toThrow(/no existe/);
    expect(() => desdeHora('nueve')).toThrow(/09:00/);
  });
});
