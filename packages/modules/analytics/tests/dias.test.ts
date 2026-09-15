import { describe, expect, it } from 'vitest';
import { diaEn, esDia, ultimosDias, TZ_POR_DEFECTO } from '../domain/dias';

// El bug que originó esto (#66): `bump` escribía el día en UTC y el rango
// del tablero se calculaba en hora local. En Chile son dos fechas distintas
// entre las 21:00 y la medianoche — y los números de hoy desaparecían.

describe('el día del negocio', () => {
  // 15 de septiembre 02:04 UTC = 14 de septiembre 23:04 en Chile.
  const nocheChilena = new Date('2026-09-15T02:04:00Z');

  it('a las 23:04 en Chile todavía es el día anterior en su calendario', () => {
    expect(diaEn('UTC', nocheChilena)).toBe('2026-09-15');
    expect(diaEn(TZ_POR_DEFECTO, nocheChilena)).toBe('2026-09-14');
  });

  it('el rango por defecto termina HOY según el negocio, no según UTC', () => {
    const rango = ultimosDias(30, TZ_POR_DEFECTO, nocheChilena);
    expect(rango.to).toBe('2026-09-14');
    // 30 días incluyendo hoy.
    expect(rango.from).toBe('2026-08-16');
    // Y lo que se escriba en ese momento cae DENTRO del rango, que es todo
    // el punto: antes quedaba un día por delante del tope.
    const escrito = diaEn(TZ_POR_DEFECTO, nocheChilena);
    expect(escrito >= rango.from && escrito <= rango.to).toBe(true);
  });

  it('un rango de un solo día es válido', () => {
    const rango = ultimosDias(1, TZ_POR_DEFECTO, nocheChilena);
    expect(rango.from).toBe(rango.to);
  });

  it('esDia rechaza lo que no es una fecha de calendario', () => {
    expect(esDia('2026-09-14')).toBe(true);
    expect(esDia('2026-9-14')).toBe(false);
    expect(esDia('ayer')).toBe(false);
    // 31 de febrero no existe: `Date` lo corre a marzo y por eso se compara
    // el texto de vuelta.
    expect(esDia('2026-02-31')).toBe(false);
    expect(esDia('')).toBe(false);
  });
});
