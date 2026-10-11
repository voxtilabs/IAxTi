import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Recorrer los archivos fuente de un árbol, una sola vez para todo el repo.
 *
 * ## Por qué existe
 *
 * Cinco guardas de `packages/core/src` tenían su propia copia privada de este
 * recorrido —`barridos-sin-lista`, `columnas-sin-lector`,
 * `entorno-con-coalescencia`, `exports-sin-consumidor`, `listas-sin-estados`—
 * y las cinco con una lista de carpetas ignoradas distinta: tres saltan
 * `coverage`, dos no; dos saltan `.claude`, tres no.
 *
 * Es la misma lección que ya dejó escrita `fuenteLimpia` (#569) una capa más
 * abajo: **cuando varios autores independientes escriben lo mismo, lo que
 * falta es el camino compartido**. Mientras no exista, cada guarda nueva
 * empieza copiando la copia que tenía más a mano, y la diferencia entre las
 * seis no la va a mirar nadie hasta que una se quede ciega.
 *
 * El caso concreto que esto evita: una guarda que no ignora `dist/` lee el
 * código COMPILADO además del fuente. Si lo que busca es una ausencia
 * —«nadie lee esta columna», «nadie emite este evento»—, el `dist` de la
 * compilación anterior le contesta que sí, y la guarda queda verde para
 * siempre sin que nada la haya puesto así a propósito.
 */
const IGNORADOS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  '.git',
  '.claude',
  'coverage',
]);

export interface OpcionesDeRecorrido {
  /** Qué archivos devolver. Por defecto, `.ts` y `.tsx` que no son de tipos. */
  extension?: RegExp;
  /**
   * Incluir las pruebas. Por defecto NO: una guarda que busca una ausencia en
   * el código de producción encuentra su propio caso de prueba y se calla.
   */
  conPruebas?: boolean;
}

const FUENTE = /\.tsx?$/;
const ES_PRUEBA = (ruta: string): boolean =>
  /[/\\]tests?[/\\]/.test(ruta) || /\.(test|spec)\.tsx?$/.test(ruta);

/** Los archivos fuente de `raiz`, recursivo, sin los árboles generados. */
export function archivosFuente(raiz: string, opciones: OpcionesDeRecorrido = {}): string[] {
  const extension = opciones.extension ?? FUENTE;
  const acc: string[] = [];
  const bajar = (dir: string): void => {
    for (const entrada of readdirSync(dir)) {
      if (IGNORADOS.has(entrada)) continue;
      const ruta = join(dir, entrada);
      if (statSync(ruta).isDirectory()) bajar(ruta);
      else if (extension.test(entrada) && !entrada.endsWith('.d.ts')) acc.push(ruta);
    }
  };
  bajar(raiz);
  return opciones.conPruebas ? acc : acc.filter((r) => !ES_PRUEBA(r));
}
