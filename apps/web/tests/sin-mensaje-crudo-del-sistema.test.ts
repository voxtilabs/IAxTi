import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';
import { ApiError, avisoDe, mensajeDeError, rastroDelError } from '../lib/api';

/**
 * Lo que la pantalla muestra cuando algo falla no es el mensaje del navegador
 * (#1161).
 *
 * El 01-11 `/ajustes/ia/detalle` mostró, en Safari y tal cual:
 * «The string did not match the expected pattern.». Es el `.message` de un
 * `DOMException` de WebKit —en inglés, sin decir qué falló— y llegó a la
 * pantalla porque `avisoDe` hacía `err instanceof Error ? err.message : …` y
 * un `DOMException` **es** un `Error`.
 *
 * Lo peor no fue el texto sino que no se pudo diagnosticar: el rastro era
 * `null` para todo lo que no fuera un error de la API, así que del reporte no
 * salía ni qué operación lo había lanzado.
 *
 * La regla del repo ya lo decía: «`message` con la voz de Pulso: qué pasó y
 * qué hacer, sin el mensaje crudo del sistema».
 */
describe('el aviso', () => {
  it('muestra el mensaje de la API y su identificador', () => {
    const err = new ApiError('CONTACT_NOT_FOUND', 'No encontramos ese contacto.', 404, 'req_1');
    expect(avisoDe(err)).toEqual({ texto: 'No encontramos ese contacto.', rastro: 'CONTACT_NOT_FOUND · req_1' });
  });

  it('muestra el mensaje que escribimos nosotros, sin rastro', () => {
    const err = new Error('No pudimos preguntarle al servidor por los avisos.');
    expect(avisoDe(err)).toEqual({ texto: 'No pudimos preguntarle al servidor por los avisos.', rastro: null });
  });

  it('NO muestra el mensaje de un DOMException: lo baja al rastro', () => {
    // El de verdad, el que vio el dueño.
    const err = new DOMException('The string did not match the expected pattern.', 'SyntaxError');
    const aviso = avisoDe(err);
    expect(aviso.texto).not.toContain('did not match');
    expect(aviso.texto).toMatch(/Intenta de nuevo/);
    expect(aviso.rastro).toBe('SyntaxError · The string did not match the expected pattern.');
  });

  it('un corte de red dice qué hacer, no «Failed to fetch»', () => {
    const aviso = avisoDe(new TypeError('Failed to fetch'));
    expect(aviso.texto).not.toContain('Failed to fetch');
    expect(aviso.texto).toMatch(/conexión/);
    expect(aviso.rastro).toBe('TypeError · Failed to fetch');
  });

  it('lo que no es un Error tampoco se muestra crudo', () => {
    expect(avisoDe('se rompió').texto).toMatch(/Algo/);
    expect(mensajeDeError({ raro: true })).toMatch(/Algo/);
    expect(rastroDelError('se rompió')).toBeNull();
  });
});

/**
 * Y la guarda de fuente: `(err as Error).message` eran 95 en 36 archivos, y
 * cada uno es una pantalla que muestra lo que el navegador haya dicho. Se
 * escanea limpio (#569): un comentario que cite el patrón no la pone roja.
 */
describe('ninguna pantalla lee el .message a mano', () => {
  const raiz = join(__dirname, '..');
  function* archivos(dir: string): Generator<string> {
    for (const entrada of readdirSync(dir)) {
      if (entrada === 'node_modules' || entrada === '.next' || entrada === 'tests') continue;
      const ruta = join(dir, entrada);
      if (statSync(ruta).isDirectory()) yield* archivos(ruta);
      else if (/\.tsx?$/.test(entrada)) yield ruta;
    }
  }

  it('usan mensajeDeError o avisoDe, no el mensaje crudo', () => {
    const culpables: string[] = [];
    for (const ruta of [...archivos(join(raiz, 'components')), ...archivos(join(raiz, 'app'))]) {
      const limpio = fuenteLimpia(readFileSync(ruta, 'utf8'));
      if (/as Error\)\s*\.message/.test(limpio)) culpables.push(ruta.slice(raiz.length + 1));
    }
    expect(
      culpables,
      'Pasá el error por `mensajeDeError(err)` o `avisoDe(err)`: el `.message` ' +
        'de un DOMException o un TypeError es el mensaje del navegador, en ' +
        'inglés, y no dice qué hacer.',
    ).toEqual([]);
  });
});
