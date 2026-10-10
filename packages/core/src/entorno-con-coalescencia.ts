import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from './testing/fuente-limpia';

/**
 * Lecturas del entorno escritas con `??` y un valor por defecto (#575).
 *
 * **`??` solo atrapa `null` y `undefined`.** Una variable declarada sin valor
 * —que es la forma normal de «apagarla» en un panel de Dokploy o en un
 * `docker-compose` con `${VAR}` sin `:-`— llega como `''`, pasa por el
 * operador y se usa como si fuera configuración. El por-defecto no entra
 * nunca.
 *
 * Esto no es un detalle de estilo. Lo que estaba pasando, medido:
 *
 *   · `PUBLIC_API_URL=""` mandaba al proveedor de pagos un `confirmUrl`
 *     RELATIVO. El cliente paga, el webhook nunca llega, el link queda
 *     `pending` para siempre y en el CRM no hay registro del pago.
 *   · `IAXTI_ENV=""` abría las DOS cerraduras del fallback de autenticación.
 *   · `IAXTI_ENV=""` montaba el simulador de mensajes entrantes EN producción.
 *   · `IAXTI_TZ=""` hacía que `Intl` lanzara `RangeError` y la medición de
 *     consumo del tenant se caía entera.
 *
 * Ninguno se ve como «la variable está mal»: se ven como que el producto está
 * roto, y cada uno manda a investigar a otra parte. Por eso se caza en CI y no
 * en revisión: son catorce sitios distintos y ninguno es sospechoso al leerlo.
 *
 * La forma correcta es `textoDeEntorno` / `enteroDeEntorno`, que tratan ausente
 * y en blanco como lo que son: dos entradas distintas.
 *
 * Y donde importar el ayudante cerraría un ciclo —`telemetry` es dependencia de
 * `core`— o arrastraría `node:fs` a un bundle del navegador —`apps/web`,
 * `apps/admin`—, la forma aceptada es `process.env.X?.trim() || defecto`, que
 * se normaliza sola. Esta guarda la acepta a propósito: no pide el ayudante,
 * pide que la cadena vacía no pase.
 */

const IGNORADOS = new Set(['node_modules', 'dist', '.next', '.claude', '.git', 'coverage']);

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (IGNORADOS.has(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) fuentes(ruta, acc);
    // Los tests quedan fuera, y es la única exclusión: ahí un
    // `process.env.DATABASE_URL ?? 'postgres://…'` es el valor de desarrollo
    // del fixture, y si llega en blanco lo que se rompe es el test, a la vista,
    // en la corrida. El defecto que esta guarda persigue es el de la
    // configuración DESPLEGADA, donde la cadena vacía se propaga callada.
    else if (/\.tsx?$/.test(entrada) && !/\.d\.ts$/.test(entrada) && !/\.test\.tsx?$/.test(entrada))
      acc.push(ruta);
  }
  return acc;
}

/**
 * `process.env.ALGO ?? …`, y qué se acepta del otro lado.
 *
 * Solo estos cuatro, porque ninguno pone un valor de configuración donde había
 * una cadena vacía: `''`, `""`, `` ` ` ``, `null` y `undefined`. El primero es
 * el idioma normal de «normalizar a texto» y suele venir seguido de un
 * `.trim()`; los otros no inventan nada.
 *
 * Una CADENA de `??` —`process.env.A ?? process.env.B ?? 'x'`— sí se reporta, y
 * a propósito: si `A` viene en blanco gana `A`, y `B` y el defecto no se miran
 * nunca. Era exactamente el caso de `internalApiUrl()`.
 *
 * La decisión de qué hay del otro lado se toma en código y no con un
 * `(?!…)` dentro de la expresión: con `\s*` delante, el motor retrocede a cero
 * espacios y el lookahead mira el espacio en vez del valor, así que `?? ''`
 * daba positivo. Lo encontró el segundo test de este archivo.
 */
const COALESCENCIA = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*\?\?\s*(\S+)/g;

/**
 * Lo que puede ir después de `??` sin que sea un defecto disfrazado.
 *
 * Se mira el COMIENZO de lo que sigue y que no continúe en un identificador:
 * `(process.env.X ?? '').trim()` es correcto y el primer bloque sin espacios
 * es `'').trim()`, no `''`. Sin el `(?![A-Za-z0-9_$])`, un `?? nullish` pasaría
 * por `null`.
 */
const INOCUO = /^(?:''|""|``|null|undefined)(?![A-Za-z0-9_$])/;

export interface LecturaConCoalescencia {
  archivo: string;
  linea: number;
  variable: string;
}

export function entornoConCoalescencia(raices: string[]): LecturaConCoalescencia[] {
  const hallazgos: LecturaConCoalescencia[] = [];
  for (const archivo of raices.flatMap((r) => fuentes(r))) {
    const limpio = fuenteLimpia(readFileSync(archivo, 'utf8'));
    // `fuenteLimpia` preserva la numeración: reemplaza por espacios, no borra.
    limpio.split('\n').forEach((linea, i) => {
      for (const [, variable, siguiente] of linea.matchAll(COALESCENCIA)) {
        // `siguiente` es el primer bloque sin espacios, así que trae pegado lo
        // que venga después: de `('' ).trim()` llega `'').trim()`.
        if (INOCUO.test(siguiente)) continue;
        hallazgos.push({ archivo, linea: i + 1, variable });
      }
    });
  }
  return hallazgos.sort((a, b) =>
    a.archivo === b.archivo ? a.linea - b.linea : a.archivo.localeCompare(b.archivo),
  );
}
