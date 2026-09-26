import { afterEach, describe, expect, it } from 'vitest';
import { versionDelBuild } from '../src/version';

/**
 * De qué build es lo que está corriendo (#565).
 *
 * Sale del tag de `IAXTI_IMAGE`, que ya llega al contenedor desde #392. Una
 * variable nueva al lado sería una segunda copia del mismo dato: la imagen
 * diría una versión y el health otra, y nada fallaría.
 */

const original = process.env.IAXTI_IMAGE;
afterEach(() => {
  if (original === undefined) delete process.env.IAXTI_IMAGE;
  else process.env.IAXTI_IMAGE = original;
});

describe('versionDelBuild (#565)', () => {
  it('saca el SHA del tag y lo acorta', () => {
    process.env.IAXTI_IMAGE = 'ghcr.io/voxtilabs/iaxti:157cc8dfcd08e83bb4f97801969ab02da8adc236';
    expect(versionDelBuild().sha).toBe('157cc8dfcd08');
  });

  it('un tag que no es un SHA no se hace pasar por versión', () => {
    // «latest» parece una respuesta y no lo es: peor que decir que no se sabe.
    for (const tag of ['latest', 'staging', 'v1.2.3']) {
      process.env.IAXTI_IMAGE = `ghcr.io/voxtilabs/iaxti:${tag}`;
      expect(versionDelBuild().sha, tag).toBeNull();
    }
  });

  it('un registro con puerto no se confunde con un tag', () => {
    // `split(':').pop()` devolvería «5000/iaxti», que no es nada.
    process.env.IAXTI_IMAGE = 'registro.interno:5000/iaxti';
    expect(versionDelBuild().sha).toBeNull();
  });

  it('un digest no es un tag', () => {
    process.env.IAXTI_IMAGE =
      'ghcr.io/voxtilabs/iaxti@sha256:157cc8dfcd08e83bb4f97801969ab02da8adc236157cc8dfcd08e83bb4f97801';
    expect(versionDelBuild().sha).toBeNull();
  });

  it('sin la variable devuelve null y no revienta', () => {
    // Desarrollo local: `docker compose up` no fija IAXTI_IMAGE, y `/health`
    // tiene que seguir contestando 200.
    delete process.env.IAXTI_IMAGE;
    expect(versionDelBuild()).toEqual({ sha: null });
  });
});
