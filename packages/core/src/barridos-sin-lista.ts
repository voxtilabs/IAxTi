import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from './testing/fuente-limpia';

/**
 * Barridos que recorren TODOS los tenants (#743).
 *
 * Seis barridos tenían el mismo defecto y se descubrieron de a uno, cada vez por
 * un test rojo: facturación (#580), recordatorios y reglas (#733), muestras
 * (#738), secuencias (#740) y los dos que cierra este issue. Todos llamaban a
 * `porCadaTenant` / `idsDeTenants` sin lista, así que visitaban a todos.
 *
 * Medido el 09/10 con 1.283 tenants: **4,5 ms** por tenant sin trabajo, **~5,8 s**
 * cada barrido. Proyectado a mil tenants con la base a 64 ms de distancia (#711):
 * minutos de un cron haciendo nada, por barrido.
 *
 * Lo que hace que esto necesite una guarda y no solo seis arreglos: **el síntoma
 * depende del tamaño de la base de desarrollo**. `sweepSequences` no salió en
 * #733 porque esa noche la base tenía menos tenants y su prueba entraba justo
 * dentro del límite de vitest. El defecto llevaba meses; lo que cambió fue
 * cuántos tenants habían acumulado las suites. Un barrido nuevo escrito mañana
 * pasaría verde.
 *
 * Mide una cosa comprobable: si la llamada pasa `ids`. El cómo se consigue esa
 * lista —una función `SECURITY DEFINER` acotada, ADR-0026— no lo juzga esto.
 */

const IGNORADOS = new Set(['node_modules', 'dist', '.next', '.claude', '.git', 'coverage']);

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (IGNORADOS.has(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) fuentes(ruta, acc);
    else if (/\.tsx?$/.test(entrada)) acc.push(ruta);
  }
  return acc;
}

/** El código sin comentarios: acá se explica por qué algo NO se hace. */
export interface LlamadaDeBarrido {
  /** Ruta relativa al repo, para que el mensaje se pueda seguir. */
  archivo: string;
  /** `porCadaTenant` o `idsDeTenants`. */
  funcion: string;
  /** Si la llamada pasa una lista de a quiénes visitar. */
  conLista: boolean;
}

/**
 * Encuentra las llamadas y dice si pasan lista.
 *
 * Pura y con los textos por parámetro para poder probarla: una guarda cuyo
 * escáner no se prueba se cae sola sin que nadie lo note, y eso ya pasó cuatro
 * veces en este repo con comentarios que nombraban lo que buscaban.
 *
 * El criterio es `ids` dentro de la llamada, y la llamada se recorta
 * BALANCEANDO paréntesis hasta el cierre real: `porCadaTenant(pool, async
 * (client, tenantId) => { … }, { ids })` tiene paréntesis anidados y la lista va
 * al final, después del callback. El callback de `sweepBilling` son ciento
 * ochenta líneas, así que un tope de caracteres cortaba antes de llegar a la
 * lista y daba a esa llamada por culpable. Lo vi al correr el escáner.
 */
export function llamadasDeBarrido(archivos: Array<{ archivo: string; codigo: string }>): LlamadaDeBarrido[] {
  const encontradas: LlamadaDeBarrido[] = [];
  for (const { archivo, codigo } of archivos) {
    const texto = fuenteLimpia(codigo);
    for (const funcion of ['porCadaTenant', 'idsDeTenants']) {
      let desde = texto.indexOf(`${funcion}(`);
      while (desde !== -1) {
        const bloque = recorteDeLaLlamada(texto, desde + funcion.length);
        encontradas.push({
          archivo,
          funcion,
          // `{ ids }`, `{ ids: algo }` o `ids,` — lo que importa es que la
          // opción viaje. Un `ids` que viene de otra variable cuenta: lo que
          // esta guarda cuida es que la decisión exista, no cómo se calcula.
          conLista: /\bids\b\s*[:,}]/.test(bloque),
        });
        desde = texto.indexOf(`${funcion}(`, desde + 1);
      }
    }
  }
  return encontradas;
}

/**
 * El texto de UNA llamada, balanceando paréntesis hasta el cierre real.
 *
 * Cortar en el primer `)` daría `(pool` y toda llamada parecería sin lista: el
 * callback va en medio y las opciones al final. Y cortar a los N caracteres
 * tampoco sirve — el callback de `sweepBilling` son ciento ochenta líneas.
 *
 * Sin tope artificial, entonces: se recorre hasta que el nivel vuelve a cero. Si
 * nunca vuelve —paréntesis sin cerrar— devuelve lo que queda del archivo, que
 * para esta guarda es lo prudente: prefiere ver de más que dar una llamada por
 * culpable porque el recorte se quedó corto.
 */
function recorteDeLaLlamada(texto: string, desdeParentesis: number): string {
  let nivel = 0;
  for (let i = desdeParentesis; i < texto.length; i += 1) {
    if (texto[i] === '(') nivel += 1;
    else if (texto[i] === ')') {
      nivel -= 1;
      if (nivel === 0) return texto.slice(desdeParentesis, i + 1);
    }
  }
  return texto.slice(desdeParentesis);
}

/** Las llamadas del repo, leyendo de disco. Los `tests/` quedan fuera. */
export function barridosDelRepo(raices: string[]): LlamadaDeBarrido[] {
  const archivos = raices
    .flatMap((r) => fuentes(r))
    .filter((f) => !/[/\\]tests?[/\\]/.test(f) && !/\.test\.tsx?$/.test(f))
    // `packages/db` es donde VIVEN las dos funciones: su propio código las
    // define y las usa entre sí, y pedirle que se pase una lista a sí mismo no
    // significa nada.
    .filter((f) => !/[/\\]packages[/\\]db[/\\]src[/\\]/.test(f))
    .map((archivo) => ({ archivo, codigo: readFileSync(archivo, 'utf8') }));
  return llamadasDeBarrido(archivos);
}
