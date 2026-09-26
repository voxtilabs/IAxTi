import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guarda: una prueba que crea un directorio temporal lo borra.
 *
 * No es higiene: llegué a **2168 directorios `iaxti-*` y más de 600 MB** en el
 * tmpfs, y lo que se rompió no fue una prueba sino la máquina, a mitad de otra
 * cosa — los procesos empezaron a fallar con ENOSPC y la salida de los comandos se
 * perdía. Seis archivos creaban directorios y ninguno los borraba;
 * `combinations.test.ts` además copia el árbol de módulos entero, una vez por
 * módulo y por corrida.
 *
 * El fallo aparece lejísimos de la causa, y eso es lo que lo hace caro: nadie
 * sospecha de una prueba que pasa en verde desde hace meses.
 */

const RAIZ = join(__dirname, '..', '..', '..');

function archivosDePrueba(dir: string, encontrados: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    // `node_modules` y las salidas de build no son nuestras.
    if (['node_modules', 'dist', '.next', '.turbo', '.git'].includes(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) archivosDePrueba(ruta, encontrados);
    else if (/\.test\.(ts|mts|mjs)$/.test(entrada)) encontrados.push(ruta);
  }
  return encontrados;
}

describe('las pruebas no dejan basura en el disco', () => {
  it('toda prueba que crea un temporal lo borra', () => {
    const archivos = archivosDePrueba(RAIZ);
    // Primero: que el escáner encuentre algo. Uno que no ve ningún archivo pasa
    // siempre, y es peor que no tenerlo.
    expect(archivos.length).toBeGreaterThan(20);

    const sinLimpiar = archivos.filter((ruta) => {
      const fuente = readFileSync(ruta, 'utf8');
      if (!fuente.includes('mkdtempSync')) return false;
      return !fuente.includes('rmSync');
    });
    expect(
      sinLimpiar.map((r) => r.slice(RAIZ.length + 1)),
      'Estas pruebas crean un directorio temporal y no lo borran. Con el tiempo ' +
        'llenan el tmpfs y rompen corridas que no tienen nada que ver.',
    ).toEqual([]);
  });
});
