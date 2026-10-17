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
 * Y el punto ciego que tenía: `const { X } = process.env` (#985).
 *
 * La expresión de arriba pide el `process.env.` escrito, así que un archivo que
 * desestructura primero quedaba invisible:
 *
 *     const { SMTP_HOST, SMTP_PORT, … } = process.env;
 *     port: Number(SMTP_PORT ?? 587),
 *
 * Eso costó un defecto real, medido en #953: el compose pasa `SMTP_PORT` sin
 * defecto, así que sin configurar llega como CADENA VACÍA; `'' ?? 587` es `''`
 * y `Number('')` es **0**. El transporte se armaba contra el puerto 0, no
 * conectaba, y el envío es mejor-esfuerzo: los correos no salían y nadie se
 * enteraba. La guarda que existe justamente para eso no lo vio por la forma en
 * que estaba escrita la lectura.
 *
 * Se recogen los nombres desestructurados —solo los que parecen variables de
 * entorno, en MAYÚSCULAS— y se les aplica la misma regla. El renombre
 * (`{ A: b }`) se queda con el nombre de la IZQUIERDA, que es el que viene del
 * entorno; si alguien lo renombra a minúsculas, esto no lo sigue, y queda
 * dicho acá en vez de fingir que sí.
 */
const DESESTRUCTURA = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env/g;

function nombresDesestructurados(textoLimpio: string): string[] {
  const nombres = new Set<string>();
  for (const [, dentro] of textoLimpio.matchAll(DESESTRUCTURA)) {
    for (const parte of dentro.split(',')) {
      const nombre = parte.split(':')[0].trim();
      if (/^[A-Z][A-Z0-9_]*$/.test(nombre)) nombres.add(nombre);
    }
  }
  return [...nombres];
}

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

/**
 * El escáner sobre un TEXTO, separado del recorrido del repo (#823).
 *
 * Está aparte para que se pueda probar con una aserción POSITIVA. La prueba de
 * esta guarda eran dos `toEqual([])` y nada más, o sea que si el escáner
 * devolviera `[]` siempre, las dos seguían verdes — y ese modo de falla no es
 * teórico: el escáner depende de `fuenteLimpia`, y ya pasó una vez que
 * `fuenteLimpia` devolviera texto en blanco y tres pruebas de #690 se
 * pusieran verdes sin comprobar nada. Lo que las delató fue una positiva.
 *
 * Recibe el texto YA limpio de comentarios: quien recorre archivos lo pasa por
 * `fuenteLimpia`, y una prueba sobre un trozo escrito a mano no lo necesita.
 */
export function coalescenciasEnTexto(textoLimpio: string): Array<{ linea: number; variable: string }> {
  const hallazgos: Array<{ linea: number; variable: string }> = [];
  // `fuenteLimpia` preserva la numeración: reemplaza por espacios, no borra.
  // Los nombres que este archivo sacó de `process.env` por desestructuración:
  // se buscan una vez y valen para todo el texto, porque el `??` puede estar
  // doscientas líneas más abajo que el `const { … }`.
  const sueltos = nombresDesestructurados(textoLimpio).map(
    (nombre) => [nombre, new RegExp(`(?<![.\\w$])${nombre}\\s*\\?\\?\\s*(\\S+)`, 'g')] as const,
  );
  textoLimpio.split('\n').forEach((linea, i) => {
    for (const [, variable, siguiente] of linea.matchAll(COALESCENCIA)) {
      // `siguiente` es el primer bloque sin espacios, así que trae pegado lo
      // que venga después: de `('' ).trim()` llega `'').trim()`.
      if (INOCUO.test(siguiente)) continue;
      hallazgos.push({ linea: i + 1, variable });
    }
    for (const [variable, patron] of sueltos) {
      for (const [, siguiente] of linea.matchAll(patron)) {
        if (INOCUO.test(siguiente)) continue;
        hallazgos.push({ linea: i + 1, variable });
      }
    }
  });
  return hallazgos;
}

export function entornoConCoalescencia(raices: string[]): LecturaConCoalescencia[] {
  const hallazgos: LecturaConCoalescencia[] = [];
  for (const archivo of raices.flatMap((r) => fuentes(r))) {
    const limpio = fuenteLimpia(readFileSync(archivo, 'utf8'));
    for (const h of coalescenciasEnTexto(limpio)) hallazgos.push({ archivo, ...h });
  }
  return hallazgos.sort((a, b) =>
    a.archivo === b.archivo ? a.linea - b.linea : a.archivo.localeCompare(b.archivo),
  );
}
