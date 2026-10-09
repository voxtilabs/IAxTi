import { describe, expect, it } from 'vitest';
import { porQueNoCorrer } from '../e2e/build-coherente.mjs';

/**
 * El e2e se niega a correr sobre un build mezclado (#637).
 *
 * El defecto que esto cierra no era el fallo: era que el fallo MENTÍA. Un
 * standalone de un build y estáticos de otro dan `ChunkLoadError`, la
 * aplicación no monta y las 71 pruebas fallan con «element(s) not found» —
 * mensajes que no apuntan a nada. Y el código sin cambios pasaba, porque sus
 * hashes calzaban con lo copiado, así que «¿es mi cambio?» se contestaba mal
 * con toda confianza. Media hora de una sesión se fue en revertir un cambio de
 * barra lateral que no tenía nada que ver.
 */
describe('porQueNoCorrer (#637)', () => {
  it('con el mismo build no objeta nada', () => {
    expect(porQueNoCorrer({ delStandalone: 'abc123', delNext: 'abc123' })).toBeNull();
  });

  it('con builds distintos dice QUÉ pasa y QUÉ hacer', () => {
    const msg = porQueNoCorrer({ delStandalone: 'viejo', delNext: 'nuevo' });
    // Los dos ids van en el mensaje: sin ellos, «no coinciden» obliga a ir a
    // buscarlos a mano justo cuando uno está apurado.
    expect(msg).toContain('viejo');
    expect(msg).toContain('nuevo');
    expect(msg).toContain('turbo build');
    // Y nombra el síntoma que la persona YA vio, para que ate los dos cabos:
    // llegó acá porque la suite estaba roja.
    expect(msg).toContain('ChunkLoadError');
  });

  it('un BUILD_ID ausente no es un desacuerdo', () => {
    // Negarse por una ausencia dejaría el e2e sin correr por un motivo que no
    // es el problema. Lo que produce la mezcla es el desacuerdo explícito.
    expect(porQueNoCorrer({ delStandalone: null, delNext: 'abc' })).toBeNull();
    expect(porQueNoCorrer({ delStandalone: 'abc', delNext: null })).toBeNull();
    expect(porQueNoCorrer({ delStandalone: null, delNext: null })).toBeNull();
  });
});
