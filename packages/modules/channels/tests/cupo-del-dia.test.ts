import { describe, expect, it } from 'vitest';
import {
  cupoDelDia,
  hayMargenParaUnAutomatismo,
  msHastaElReinicioDelCupo,
  RESERVA_PARA_PERSONAS,
  TOPE_SI_NO_SE_SABE,
} from '../domain/cupo-del-dia';

/**
 * El cupo diario del canal, con margen para las personas (#1248).
 *
 * Lo que esto fija es la asimetría: un automatismo se difiere cuando queda
 * poco, una persona no. Medido el 3 de noviembre, el pulso del evento gastó
 * 182 mensajes sobre 91 entrantes y los 31 de despedida fallaron todos.
 */
describe('el cupo del día (#1248)', () => {
  it('sin configuración, asume el tope de un número sin medio de pago y lo dice', () => {
    const c = cupoDelDia({ enviados: 0 });
    expect(c.tope).toBe(TOPE_SI_NO_SE_SABE);
    expect(c.topeAsumido, 'quien lo lea tiene que saber que es un supuesto').toBe(true);
    expect(c.reserva).toBe(RESERVA_PARA_PERSONAS);
    expect(c.quedanParaAutomatismos).toBe(200);
  });

  it('reproduce el día del evento: con 182 enviados todavía hay margen', () => {
    const c = cupoDelDia({ enviados: 182 });
    expect(c.quedan).toBe(68);
    expect(c.quedanParaAutomatismos).toBe(18);
    expect(hayMargenParaUnAutomatismo(c)).toBe(true);
  });

  it('y con 200 ya no: el automatismo espera y los 50 quedan para las personas', () => {
    const c = cupoDelDia({ enviados: 200 });
    expect(c.quedan).toBe(50);
    expect(c.quedanParaAutomatismos).toBe(0);
    expect(hayMargenParaUnAutomatismo(c)).toBe(false);
  });

  it('el tope configurado manda sobre el asumido', () => {
    const c = cupoDelDia({ enviados: 300, config: { topeDiario: 1000 } });
    expect(c.tope).toBe(1000);
    expect(c.topeAsumido).toBe(false);
    expect(c.quedanParaAutomatismos).toBe(650);
  });

  it('una configuración que no sirve cae al supuesto, no a cero', () => {
    // Un `0`, un negativo o una cadena vacía dejarían el canal mudo para
    // siempre, y «no funciona» sin que nada lo explique.
    for (const topeDiario of [0, -5, '', 'muchos', null, undefined, 1.5e9]) {
      const c = cupoDelDia({ enviados: 0, config: { topeDiario } });
      expect(c.tope, String(topeDiario)).toBeGreaterThan(0);
    }
    // Y un número escrito como texto SÍ sirve: viene de un jsonb.
    expect(cupoDelDia({ enviados: 0, config: { topeDiario: '1000' } }).tope).toBe(1000);
  });

  it('la reserva nunca se come el tope entero', () => {
    // Un canal con tope 20 y la reserva por omisión de 50 dejaría a los
    // automatismos sin nada para siempre.
    const c = cupoDelDia({ enviados: 0, config: { topeDiario: 20 } });
    expect(c.reserva).toBe(10);
    expect(c.quedanParaAutomatismos).toBe(10);
  });

  it('pasado el tope no devuelve negativos', () => {
    const c = cupoDelDia({ enviados: 400 });
    expect(c.quedan).toBe(0);
    expect(c.quedanParaAutomatismos).toBe(0);
  });

  /**
   * El reinicio es a medianoche UTC y está MEDIDO: el 3 de noviembre el cupo
   * se renovó a las 21:00 de Chile. Diferir hasta la medianoche local dejaría
   * el mensaje esperando tres horas de más, y en el otro sentido lo soltaría
   * antes del reinicio para que vuelva a fallar.
   */
  it('difiere hasta la medianoche UTC, no hasta la del negocio', () => {
    // 21:00 de Chile = medianoche UTC: falta el mínimo, no tres horas.
    expect(msHastaElReinicioDelCupo(new Date('2026-11-03T23:59:00Z'))).toBe(60_000);
    // Mediodía UTC: faltan doce horas.
    expect(msHastaElReinicioDelCupo(new Date('2026-11-03T12:00:00Z'))).toBe(12 * 3_600_000);
    // Justo en el cambio de día no devuelve 0: un delay de 0 haría girar el
    // job sin esperar.
    expect(msHastaElReinicioDelCupo(new Date('2026-11-03T00:00:00Z'))).toBe(86_400_000);
    expect(msHastaElReinicioDelCupo(new Date('2026-11-03T23:59:59.500Z'))).toBe(60_000);
  });
});
