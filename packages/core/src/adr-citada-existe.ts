import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from './testing/fuente-limpia';

/**
 * Cada `ADR-00NN` que el código cita existe como página (#1292).
 *
 * Este repo apoya sus decisiones en los ADR y las cita desde el código, que es
 * lo correcto: un comentario que dice «cerrada por ADR-0017» le ahorra a quien
 * lee tener que deducir por qué algo no se hizo. El problema es cuando el
 * puntero no lleva a ninguna parte, y eso pasó de dos formas:
 *
 *  - **El ADR nunca se mergeó.** `hilos-del-agente.ts` citaba `ADR-0029` para
 *    justificar que los hilos caducan a los 30 días, y ese ADR llevaba seis
 *    días en un PR abierto como *propuesta*. El código daba por decidido algo
 *    que no estaba escrito.
 *  - **Otro ADR se quedó con el número.** Mientras ese PR esperaba, el 0029 se
 *    lo llevó una decisión distinta —el agente tomando la hora—. Así que las
 *    citas del hilo seguían resolviendo a un archivo que existía y hablaba de
 *    otra cosa: el peor caso, porque nadie ve un error.
 *
 * La guarda comprueba lo único comprobable: que el número citado tenga su
 * página. Que la página hable del tema no lo puede medir —eso lo ve quien
 * revisa—, pero el caso de arriba habría quedado rojo igual: al renumerar las
 * citas a 0031, esto se pone rojo hasta que la página 0031 esté en el repo.
 *
 * Mira la fuente LIMPIA porque este archivo nombra ADRs en su propio
 * comentario, y sin eso se pondría rojo por explicarse.
 */

const IGNORADOS = new Set(['node_modules', 'dist', '.next', '.claude', '.git', 'coverage']);

export interface CitaDeAdr {
  /** `ADR-0029`, tal como lo nombra el código. */
  adr: string;
  /** Dónde se cita, relativo a la raíz. */
  donde: string;
}

function archivos(dir: string, extension: RegExp, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (IGNORADOS.has(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) archivos(ruta, extension, acc);
    else if (extension.test(entrada)) acc.push(ruta);
  }
  return acc;
}

/** Los números de las páginas que hay en `docs/adr/`. */
export function adrsQueExisten(dirAdr: string): Set<string> {
  const numeros = new Set<string>();
  for (const entrada of readdirSync(dirAdr)) {
    const n = /^(\d{4})-/.exec(entrada)?.[1];
    if (n) numeros.add(n);
  }
  return numeros;
}

/**
 * Las citas del código que no tienen página.
 *
 * `raices` son los árboles de código; `dirAdr`, la carpeta de las páginas.
 */
export function adrsCitadasSinPagina(raices: string[], dirAdr: string): CitaDeAdr[] {
  const existen = adrsQueExisten(dirAdr);
  const faltan: CitaDeAdr[] = [];
  for (const ruta of raices.flatMap((r) => archivos(r, /\.(ts|tsx)$/))) {
    const texto = readFileSync(ruta, 'utf8');
    // La fuente limpia saca comentarios, y las citas VIVEN en comentarios. Lo
    // que se saca es la fuente limpia del PROPIO escáner y sus pruebas, para
    // que no cuenten los ejemplos con que se explican.
    const esDelEscaner = /adr-citada-existe/.test(ruta);
    const aMirar = esDelEscaner ? fuenteLimpia(texto) : texto;
    for (const m of aMirar.matchAll(/\bADR-(\d{4})\b/g)) {
      if (!existen.has(m[1])) {
        faltan.push({ adr: `ADR-${m[1]}`, donde: ruta.replace(/^.*?((?:packages|apps)\/)/, '$1') });
      }
    }
  }
  // Una cita por ADR y archivo: el mismo puntero repetido en veinte líneas es
  // un hallazgo, no veinte.
  const vistas = new Set<string>();
  return faltan.filter((c) => {
    const llave = `${c.adr}@${c.donde}`;
    if (vistas.has(llave)) return false;
    vistas.add(llave);
    return true;
  });
}

/** Dos páginas con el mismo número: el caso que no da error en ninguna parte. */
export function adrsConNumeroRepetido(dirAdr: string): string[] {
  const porNumero = new Map<string, string[]>();
  for (const entrada of readdirSync(dirAdr)) {
    const n = /^(\d{4})-/.exec(entrada)?.[1];
    if (!n) continue;
    porNumero.set(n, [...(porNumero.get(n) ?? []), entrada]);
  }
  return [...porNumero.entries()]
    .filter(([, archivos]) => archivos.length > 1)
    .map(([n, archivos]) => `${n}: ${archivos.join(', ')}`);
}
