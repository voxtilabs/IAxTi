import { describe, expect, it } from 'vitest';
import { releaseDeLaImagen } from '../src/index';

/**
 * De qué versión viene cada error (#392).
 *
 * Sin `release`, en Sentry todos se ven iguales vengan del deploy de hace
 * cinco minutos o del de la semana pasada, y nunca marca una regresión:
 * para eso compara releases. Con dos personas entrando PRs seguidos, "¿esto
 * ya estaba o lo acabo de romper?" es la pregunta que más se hace.
 *
 * El identificador ya existía y es exacto —la imagen se fija por SHA del
 * commit— y solo no llegaba al proceso.
 */
describe('el release sale de la imagen que está corriendo', () => {
  it('toma la etiqueta', () => {
    expect(releaseDeLaImagen('ghcr.io/voxtilabs/iaxti:24115b3')).toBe('24115b3');
    expect(releaseDeLaImagen('ghcr.io/voxtilabs/iaxti:v1.4.0')).toBe('v1.4.0');
  });

  it('un registro con puerto no se confunde con una etiqueta', () => {
    // `registro:5000/imagen` tiene un `:` que NO es etiqueta. Partir por el
    // primero devolvería "5000/imagen".
    expect(releaseDeLaImagen('registro:5000/iaxti')).toBeUndefined();
    expect(releaseDeLaImagen('registro:5000/iaxti:abc123')).toBe('abc123');
  });

  it('sin etiqueta útil no inventa una', () => {
    // Un release falso agrupa mal, que es peor que no agrupar. Y `latest`
    // es móvil: apunta a otro commit mañana.
    expect(releaseDeLaImagen('ghcr.io/voxtilabs/iaxti')).toBeUndefined();
    expect(releaseDeLaImagen('ghcr.io/voxtilabs/iaxti:latest')).toBeUndefined();
    expect(releaseDeLaImagen('')).toBeUndefined();
    expect(releaseDeLaImagen(undefined)).toBeUndefined();
    expect(releaseDeLaImagen('   ')).toBeUndefined();
  });

  it('sale de la variable y no de una constante', () => {
    const antes = process.env.IAXTI_IMAGE;
    try {
      process.env.IAXTI_IMAGE = 'ghcr.io/voxtilabs/iaxti:deadbee';
      expect(releaseDeLaImagen()).toBe('deadbee');
    } finally {
      if (antes === undefined) delete process.env.IAXTI_IMAGE;
      else process.env.IAXTI_IMAGE = antes;
    }
  });
});
