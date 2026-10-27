import { describe, expect, it } from 'vitest';
import { etiquetaDeLaVentana } from '../lib/api';

/**
 * La etiqueta de la ventana de 24 h (#1085).
 *
 * `ui-pulso.md` la declaraba —«etiqueta `warn` a < 2 h y `bad` cerrada»—, la
 * API calculaba `cierraA` PARA ELLA (su comentario lo dice) y ningún
 * componente leía el campo. El operador veía dos estados, «puedo escribir» y
 * «no puedo», y nunca cuánto le quedaba.
 *
 * Todos los instantes son FIJOS: lo que se mide es una diferencia entre dos
 * momentos, y con el reloj de la máquina estas pruebas solo podrían fallar en
 * ventanas de dos horas al día.
 */
const CIERRE = '2026-10-27T19:35:26.000Z';
const antesDelCierre = (minutos: number) =>
  new Date(new Date(CIERRE).getTime() - minutos * 60_000);

describe('la etiqueta de la ventana de 24 h (#1085)', () => {
  it('lejos del cierre no hay etiqueta: una cabecera con todo marcado no marca nada', () => {
    expect(etiquetaDeLaVentana({ cierraA: CIERRE }, antesDelCierre(20 * 60))).toBeNull();
    // Justo en el borde de las dos horas tampoco: el umbral es «menos de».
    expect(etiquetaDeLaVentana({ cierraA: CIERRE }, antesDelCierre(121))).toBeNull();
  });

  it('a menos de dos horas avisa en warn, con lo que queda', () => {
    const dosHoras = etiquetaDeLaVentana({ cierraA: CIERRE }, antesDelCierre(119));
    expect(dosHoras).toMatchObject({ rol: 'warn', texto: 'Quedan 1 h 59 min' });
    const cuarenta = etiquetaDeLaVentana({ cierraA: CIERRE }, antesDelCierre(40));
    expect(cuarenta).toMatchObject({ rol: 'warn', texto: 'Quedan 40 min' });
    // Minutos y no «1 h» redondeado: a esta altura la diferencia entre 119 y
    // 20 minutos es la diferencia entre contestar después y contestar ahora.
    expect(etiquetaDeLaVentana({ cierraA: CIERRE }, antesDelCierre(1))?.texto).toBe('Quedan 1 min');
  });

  it('cerrada es bad, y dice qué se puede hacer', () => {
    const cerrada = etiquetaDeLaVentana({ cierraA: CIERRE }, new Date(CIERRE));
    expect(cerrada?.rol).toBe('bad');
    expect(cerrada?.texto).toBe('Ventana cerrada');
    expect(cerrada?.titulo).toMatch(/plantilla aprobada/);
    // Un día después sigue cerrada, no vuelve a `warn` por el otro lado.
    expect(etiquetaDeLaVentana({ cierraA: CIERRE }, antesDelCierre(-24 * 60))?.rol).toBe('bad');
  });

  it('sin `cierraA` no hay etiqueta, y eso cubre dos casos distintos', () => {
    // Los canales declarados sin ventana (`webchat`, `simulador`) devuelven
    // `null`: son nuestros y no cierran, así que una etiqueta ahí sería falsa.
    expect(etiquetaDeLaVentana({ cierraA: null }, new Date(CIERRE))).toBeNull();
    // Y una API vieja que todavía no manda el campo: sin etiqueta, como antes.
    expect(etiquetaDeLaVentana({}, new Date(CIERRE))).toBeNull();
    // Una fecha que no se entiende tampoco inventa nada.
    expect(etiquetaDeLaVentana({ cierraA: 'cuando sea' }, new Date(CIERRE))).toBeNull();
  });
});
