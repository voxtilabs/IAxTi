import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from './testing/fuente-limpia';

/**
 * Cada `toISOString().slice(0, 10)` del repo, para que diga si es una CLAVE o
 * algo MOSTRADO (#1076).
 *
 * ## Por qué el patrón no se prohíbe
 *
 * Porque la mayoría de los usos son correctos. `toISOString().slice(0, 10)` es
 * la forma canónica de armar una **clave** de día en UTC, y el repo la necesita:
 * el día de la cuota de la API, el mes de facturación, el nombre de un archivo
 * exportado. Prohibirlo obligaría a inventar una excepción por cada clave
 * legítima, y una regla que la mayoría incumple se termina incumpliendo — lo
 * mismo que midió #784 con las consultas entre módulos.
 *
 * Lo que sí es un defecto es usarlo para una fecha que una PERSONA lee. UTC no
 * es la zona de nadie: en Chile, cada noche a partir de las 21:00, esa fecha
 * adelanta un día. Tres veces apareció con esa forma exacta y las tres veces
 * nadie lo vio de conjunto:
 *
 *  - #1072 — la portada fechaba el último mensaje al día siguiente.
 *  - #1074 — el panel de reportes pedía una ventana corrida, y los NÚMEROS
 *    salían de otros días.
 *  - #1076 — dos pantallas no coincidían en qué día se borra el historial del
 *    cliente, y el README de la exportación prometía enlaces un día más de lo
 *    que duraban.
 *
 * Así que la guarda no prohíbe: **obliga a declarar**. Cada sitio dice cuál de
 * los dos es, y el que es MOSTRADO tiene que salir de `diaEn(zona, …)` con la
 * zona del negocio.
 *
 * ## Lo que esto NO puede ver, dicho para que nadie lo suponga
 *
 * No distingue clave de mostrado por su cuenta — es exactamente el juicio que
 * la lista pide a mano. Y no ve la otra mitad del problema: una cadena de día
 * (`AAAA-MM-DD`) que pasa por `new Date(…).toLocaleDateString()` se corre un
 * día para el otro lado, y eso vive en el navegador, con otra forma. Esa es la
 * que se arregló en `retencion-aviso.tsx`; medirla pide otro escáner.
 */

//  y  quedan fuera como en el resto de los escáneres: una prueba
// que arma un día en UTC lo hace para comparar contra lo que el código guarda,
// y pedirle que declare el motivo es ruido sobre ruido.
const IGNORADOS = new Set(['node_modules', 'dist', '.next', '.git', 'coverage', 'tests', 'e2e']);

/** La forma exacta que se declara. Las variantes con espacios cuentan igual. */
const PATRON = /toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/g;

export interface DiaEnUtc {
  /** Ruta relativa a la raíz del repo. */
  archivo: string;
  /** Cuántas veces aparece en ese archivo. */
  veces: number;
}

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (IGNORADOS.has(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) fuentes(ruta, acc);
    else if (/\.(ts|tsx|mjs)$/.test(entrada) && !/\.d\.ts$/.test(entrada)) acc.push(ruta);
  }
  return acc;
}

/**
 * Dónde y cuántas veces aparece el patrón, con la fuente LIMPIA (#569): este
 * archivo mismo lo nombra en su comentario, y una guarda que se cuenta a sí
 * misma enseña a apagarla.
 */
export function diasEnUtc(raices: string[]): DiaEnUtc[] {
  const encontrados: DiaEnUtc[] = [];
  for (const raiz of raices) {
    for (const archivo of fuentes(raiz)) {
      const codigo = fuenteLimpia(readFileSync(archivo, 'utf8'));
      const veces = [...codigo.matchAll(PATRON)].length;
      if (veces > 0) encontrados.push({ archivo, veces });
    }
  }
  return encontrados.sort((a, b) => a.archivo.localeCompare(b.archivo));
}
