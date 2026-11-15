import { describe, expect, it } from 'vitest';
import { permisoParaEscribirle } from '../application/contacts';

/**
 * El permiso para escribirle primero, con su motivo (SPEC §8, #1346).
 *
 * La columna de Contactos y el envío leen la MISMA función: si la lista dice
 * «escribió primero», el envío tiene que dejar pasar; si dice «se dio de
 * baja», nada sale. Lo que se prueba acá es la regla; que el envío la use se
 * ve en que `canReceiveBusinessInitiated` ya no tiene lógica propia.
 */
const sinNada = { optInAt: null, optedOutAt: null };

describe('el permiso para escribirle', () => {
  it('la baja manda sobre todo, incluso sobre un opt-in anterior', () => {
    expect(permisoParaEscribirle({ optInAt: '2026-01-01', optedOutAt: '2026-02-01', origin: 'whatsapp' })).toBe('baja');
  });

  it('el opt-in registrado es permiso', () => {
    expect(permisoParaEscribirle({ ...sinNada, optInAt: '2026-01-01', origin: 'importado' })).toBe('opt_in');
  });

  it('quien escribió por cualquier canal escribió primero', () => {
    for (const origin of ['whatsapp', 'webchat', 'instagram', 'messenger']) {
      expect(permisoParaEscribirle({ ...sinNada, origin })).toBe('escribio_primero');
    }
  });

  it('importado o creado a mano, sin opt-in, no tiene permiso', () => {
    expect(permisoParaEscribirle({ ...sinNada, origin: 'importado' })).toBe('sin_permiso');
    expect(permisoParaEscribirle({ ...sinNada, origin: 'manual' })).toBe('sin_permiso');
  });
});
