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
    // `.claude` guarda copias del repo (worktrees de agentes): no son fuente
    // nuestra y las encontraría dos veces.
    if (['node_modules', 'dist', '.next', '.turbo', '.git', '.claude'].includes(entrada)) continue;
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

  /**
   * La otra basura: la que queda en la BASE (#910, #804, #913).
   *
   * Una prueba que necesita que una escritura falle tenía dos formas de
   * conseguirlo, y las dos tocaban el esquema compartido: crear un trigger que
   * lanza, o renombrar la tabla. Con un `finally` parece controlado, pero el
   * `finally` no corre si el proceso muere en el medio —Ctrl-C, OOM, el
   * timeout de la suite— y entonces el trigger se queda en la base para
   * siempre, apuntando a un tenant que ya no existe. Nada falla y nadie se
   * entera, que es la forma más cara de romper algo.
   *
   * Y mientras la ventana está abierta, el objeto es de TODAS las conexiones:
   * los 60 y pico de archivos que vitest corre en paralelo contra la misma
   * base lo ven. En #913 eso dejó rojos prestados en otros archivos.
   *
   * La forma correcta es provocar el fallo donde NACE la consulta: desviar el
   * nombre de la tabla en el texto que sale por ESA conexión. El error lo
   * sigue poniendo Postgres —así la transacción se aborta de verdad— y el
   * catálogo no se toca. Hay dos ejemplos para copiar:
   * `payments/tests/aviso-de-pago.test.ts` y
   * `workers/tests/outbound-vigencia.test.ts`.
   *
   * Lo que NO entra acá: `sinTriggers` (#803), que apaga los triggers de la
   * SESIÓN con `session_replication_role` y no deja nada atrás.
   */
  it('ninguna prueba crea triggers ni funciones en el esquema compartido', () => {
    const archivos = archivosDePrueba(RAIZ);
    expect(archivos.length).toBeGreaterThan(20);

    // `CREATE OR REPLACE FUNCTION` incluido: reemplazar una función que ya
    // existe es peor todavía, porque la deja cambiada para todo el mundo.
    const DDL = /CREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|FUNCTION)\b/i;
    const RENAME = /ALTER\s+TABLE\s+\S+\s+RENAME\b/i;

    /**
     * Los comentarios no crean nada.
     *
     * Sin esto, `arranque.test.ts` aparecería acá por EXPLICAR —en el
     * comentario que dejó #913— que antes renombraba la tabla. Una guarda que
     * acusa a quien documenta cómo dejó de hacerlo enseña a no documentarlo.
     */
    const sinComentarios = (fuente: string) =>
      fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    /**
     * La excepción, con su motivo: crea su PROPIA tabla para probar que
     * `sinTriggers` (#803) apaga triggers de verdad, y la deja caer con
     * `DROP … CASCADE`. No toca ninguna tabla del producto, y como empieza con
     * `DROP IF EXISTS`, un proceso muerto a medias se arregla solo en la
     * corrida siguiente.
     */
    const CON_SU_PROPIA_TABLA = ['packages/db/tests/sin-triggers.test.ts'];

    const culpables = archivos.filter((ruta) => {
      const relativa = ruta.slice(RAIZ.length + 1);
      if (CON_SU_PROPIA_TABLA.includes(relativa)) return false;
      const fuente = sinComentarios(readFileSync(ruta, 'utf8'));
      return DDL.test(fuente) || RENAME.test(fuente);
    });
    expect(
      culpables.map((r) => r.slice(RAIZ.length + 1)),
      'Estas pruebas crean objetos en el esquema de la base compartida. Si el ' +
        'proceso muere antes del `finally`, quedan ahí para siempre; y mientras ' +
        'existen, los ven todos los archivos que corren en paralelo. Para ' +
        'provocar un fallo de escritura, desvía el nombre de la tabla en el ' +
        'texto de la consulta de ESA conexión (#910).',
    ).toEqual([]);
  });
});
