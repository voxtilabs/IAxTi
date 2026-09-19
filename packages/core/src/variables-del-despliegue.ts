import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Qué variables de entorno lee el código que se despliega.
 *
 * Existe para la guarda de `tests/variables-del-despliegue.test.ts`, no
 * para runtime: nadie llama a esto en producción.
 */

/** Carpetas que NO son código desplegado. */
const IGNORADAS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'tests',
  'e2e',
  'migrations',
  'coverage',
]);

const EXTENSIONES = ['.ts', '.tsx'];

function esCodigoDesplegado(archivo: string): boolean {
  if (!EXTENSIONES.some((e) => archivo.endsWith(e))) return false;
  if (archivo.endsWith('.d.ts')) return false;
  if (archivo.endsWith('.test.ts') || archivo.endsWith('.test.tsx')) return false;
  if (archivo.endsWith('.config.ts')) return false;
  return true;
}

function* archivosDe(dir: string): Generator<string> {
  let entradas: string[];
  try {
    entradas = readdirSync(dir);
  } catch {
    return;
  }
  for (const entrada of entradas) {
    if (IGNORADAS.has(entrada)) continue;
    const ruta = join(dir, entrada);
    let esDir = false;
    try {
      esDir = statSync(ruta).isDirectory();
    } catch {
      continue;
    }
    if (esDir) yield* archivosDe(ruta);
    else if (esCodigoDesplegado(ruta)) yield ruta;
  }
}

/**
 * Los comentarios no cuentan.
 *
 * La primera versión de esto reportó `FOO` y `X` como variables del
 * producto: salían de los ejemplos en los propios comentarios que
 * documentan el escáner. Se quitan los bloques `/* *\/` y las líneas que
 * empiezan con `//` o `*`; NO se corta a mitad de línea, porque `//`
 * también aparece dentro de cualquier URL y ahí sí se perdería una lectura
 * de verdad.
 */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

/** `process.env.FOO` y `process.env['FOO']`. */
const LECTURA = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g;

/**
 * `const { FOO, BAR } = process.env`.
 *
 * Esta forma es la que dejó pasar el bug: `email.ts` lee las cinco
 * variables de SMTP desestructurando, y un escáner que solo mira
 * `process.env.X` no ve ninguna. O sea que la guarda habría dado verde
 * sobre exactamente el caso que la motivó.
 */
const DESESTRUCTURADA = /\{([^{}]*)\}\s*=\s*process\.env\b/g;

export interface LecturaDeVariable {
  nombre: string;
  archivos: string[];
}

/** Las variables que lee el código desplegado, con dónde se leen. */
export function variablesQueLeeElCodigo(raices: string[]): LecturaDeVariable[] {
  const encontradas = new Map<string, Set<string>>();
  for (const raiz of raices) {
    for (const archivo of archivosDe(raiz)) {
      let texto: string;
      try {
        texto = sinComentarios(readFileSync(archivo, 'utf8'));
      } catch {
        continue;
      }
      const anotar = (nombre: string) => {
        const donde = encontradas.get(nombre) ?? new Set<string>();
        donde.add(archivo);
        encontradas.set(nombre, donde);
      };
      for (const m of texto.matchAll(LECTURA)) {
        const nombre = m[1] ?? m[2];
        if (nombre) anotar(nombre);
      }
      for (const m of texto.matchAll(DESESTRUCTURADA)) {
        for (const parte of m[1].split(',')) {
          // `FOO` o `FOO: alias` o `FOO = 'defecto'`.
          const nombre = parte.trim().split(/[:=]/)[0].trim();
          if (/^[A-Z][A-Z0-9_]*$/.test(nombre)) anotar(nombre);
        }
      }
    }
  }
  return [...encontradas.entries()]
    .map(([nombre, archivos]) => ({ nombre, archivos: [...archivos].sort() }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

/**
 * Las claves que un compose entrega al contenedor.
 *
 * No parsea YAML a propósito: los compose usan anclas (`<<: *app-env`) y lo
 * único que importa acá es qué nombres aparecen como clave del bloque de
 * entorno. Una línea `  FOO: ${FOO}` cuenta; `# FOO` no.
 */
export function variablesQueEntregaElCompose(rutaDelCompose: string): Set<string> {
  const texto = readFileSync(rutaDelCompose, 'utf8');
  const claves = new Set<string>();
  for (const linea of texto.split('\n')) {
    const sinComentario = linea.split('#')[0];
    const m = /^\s{2,}([A-Z][A-Z0-9_]*)\s*:/.exec(sinComentario);
    if (m) claves.add(m[1]);
  }
  return claves;
}
