import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { CountryCode } from 'libphonenumber-js';

// Reglas transversales del negocio aplicadas en dominio (SPEC §8):
// teléfonos E.164, RUT con dígito verificador, opt-out automático.

/**
 * De dónde es un número cuando no lo dice.
 *
 * Chile, y por ahora fijo: es el país del producto. Queda como constante —y no
 * escrito en cada llamada— para que el día que se vuelva configurable por tenant
 * haya un solo lugar donde cambiarlo.
 */
export const PAIS_POR_DEFECTO: CountryCode = 'CL';

/**
 * Normaliza a E.164, validando contra el plan de numeración real (#582).
 *
 * ## Qué hacían mal las cinco expresiones regulares que esto reemplaza
 *
 * ```ts
 * if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;     // 1
 * if (/^09?\d{8}$/.test(digits)) return `+569${digits.slice(-8)}`;  // 2
 * ```
 *
 *  1. **Aceptaban cualquier cosa con forma internacional.** `+99999999999`
 *     pasaba: once dígitos y empieza con 9. El país 999 no existe, pero el
 *     contacto se guardaba y el rechazo lo daba el proveedor — que desde #556 es
 *     un fallo permanente que termina leyendo el vendedor.
 *  2. **El `slice(-8)` era una apuesta**, y es la que más duele: con un número
 *     mal tipeado **inventaba** uno válido en vez de rechazarlo, y ahí el
 *     mensaje le llega a otra persona. No falla: acierta mal.
 *  3. **Un número extranjero en formato local se rechazaba.** Un contacto
 *     argentino escrito `011 4444 5555` no pasaba, y en una importación de miles
 *     la fila se caía sin que el negocio supiera por qué.
 *
 * `libphonenumber-js` resuelve los tres: parsea formatos locales, valida contra
 * el plan de numeración de cada país y formatea a E.164. Metadata `min`
 * (81 KB medidos, la que trae el import por defecto) y esto corre en el
 * servidor, donde el peso importa poco.
 *
 * ## Por qué `min` y no `max`
 *
 * Medido con los dos: `max` rechaza `+56912345678` porque el bloque `91` no está
 * asignado en Chile. Tiene razón —es un número inventado, de los que usan las
 * pruebas— pero rechazar por bloque no asignado es rechazar números que mañana
 * existen, y el repositorio está lleno de ese dato de prueba. `min` valida país
 * y longitud, que es lo que separa un teléfono de algo que no lo es.
 *
 * ## El país por defecto
 *
 * Chile, porque es lo que la gente tipea: `9 1234 5678` sigue funcionando igual
 * que antes. Y es un parámetro porque **sin saber el país, un número local
 * extranjero es indistinguible de uno chileno**: `987 654 321` es un celular
 * chileno válido Y un celular peruano válido, y con Chile por defecto se guarda
 * como chileno. Eso no es un defecto que se pueda arreglar adivinando — es lo
 * que significa un número sin código de país. Quien sepa el país lo pasa.
 */
export function normalizePhone(raw: string, pais: CountryCode = PAIS_POR_DEFECTO): string {
  const texto = (raw ?? '').trim();
  // El `??` no basta: un número que no se puede validar vuelve como OBJETO
  // inválido, no como null, así que la alternativa del prefijo viejo nunca se
  // llegaba a probar. Lo cazó la prueba de `091234-5678`, que es justo el
  // formato que esto tiene que seguir aceptando.
  const primero = parsePhoneNumberFromString(texto, pais);
  const parseado = primero?.isValid() ? primero : conPrefijoViejo(texto, pais);
  if (!parseado?.isValid()) {
    throw new Error(
      `Teléfono inválido: "${raw}". Usa formato internacional (+56 9 1234 5678) o un número ` +
        'local del país del contacto.',
    );
  }
  return parseado.number;
}

/**
 * El `0` de los celulares chilenos de antes (`09 8765 4321`).
 *
 * La librería lo rechaza —Chile eliminó el prefijo de larga distancia nacional—
 * y la versión vieja de esto lo aceptaba, así que quitarlo sin más rompería a
 * quien lo sigue tipeando. Se quita UN cero inicial y se vuelve a parsear: si lo
 * que queda es un número válido, era eso.
 *
 * No es lo mismo que el `slice(-8)` que esto reemplaza: ahí se tomaban los
 * últimos ocho dígitos asumiendo que el resto sobraba —y con un dígito de más
 * eso producía un número DISTINTO del tipeado—. Acá se quita exactamente un
 * carácter conocido y después se valida; si no valida, se rechaza.
 */
function conPrefijoViejo(texto: string, pais: CountryCode) {
  if (pais !== 'CL') return null;
  const sinSeparadores = texto.replace(/[\s\-().]/g, '');
  if (!/^0\d+$/.test(sinSeparadores)) return null;
  return parsePhoneNumberFromString(sinSeparadores.slice(1), pais) ?? null;
}

/**
 * Móvil, fijo, o no se puede saber (#582).
 *
 * Tres estados y no un booleano, porque para Chile la librería **no puede
 * decidirlo**: con la metadata `min` no hay tipos, y con `max` los números
 * chilenos vuelven como `FIXED_LINE_OR_MOBILE`. O sea que un booleano tendría
 * que mentir en una de las dos direcciones, y la dirección peligrosa es decir
 * «no es móvil» de un celular y bloquear un envío legítimo.
 *
 * Para Chile se decide con el plan de numeración, que es estable y público: los
 * celulares son `+569XXXXXXXX` y los fijos empiezan con 2 (Santiago) o 3-8
 * (regiones). Para el resto de los países devuelve `no_se` en vez de inventar
 * una regla por país que nadie va a mantener.
 *
 * Quien lo use tiene que tratar `no_se` como «adelante»: bloquear por una duda
 * es bloquear a un cliente de verdad.
 */
export type TipoDeLinea = 'movil' | 'fijo' | 'no_se';

export function tipoDeLinea(e164: string): TipoDeLinea {
  if (!e164.startsWith('+56')) return 'no_se';
  const nacional = e164.slice(3);
  if (/^9\d{8}$/.test(nacional)) return 'movil';
  if (/^[2-8]\d{8}$/.test(nacional)) return 'fijo';
  return 'no_se';
}

/** Valida RUT chileno con dígito verificador; devuelve normalizado NNNNNNNN-D. */
export function normalizeRut(raw: string): string {
  const clean = raw.replace(/[.\s]/g, '').replace('-', '').toUpperCase();
  if (!/^\d{7,8}[0-9K]$/.test(clean)) {
    throw new Error(`RUT inválido: "${raw}".`);
  }
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  let sum = 0;
  let factor = 2;
  for (const c of [...body].reverse()) {
    sum += Number(c) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const expected = 11 - (sum % 11);
  const dvCalc = expected === 11 ? '0' : expected === 10 ? 'K' : String(expected);
  if (dv !== dvCalc) {
    throw new Error(`RUT inválido: "${raw}" (dígito verificador no coincide).`);
  }
  return `${body}-${dv}`;
}

const OPT_OUT_PATTERNS = [
  /\bbasta\b/i,
  /\bstop\b/i,
  /\bno\s+me\s+escriban?\b/i,
  /\bno\s+me\s+contacten?\b/i,
  /\bno\s+quiero\s+(m[aá]s\s+)?mensajes\b/i,
  /\bdesuscribir(me)?\b/i,
  /\bunsubscribe\b/i,
];

/** "BASTA", "STOP" y equivalentes marcan opt-out automático (SPEC §8). */
export function isOptOutMessage(text: string): boolean {
  return OPT_OUT_PATTERNS.some((p) => p.test(text));
}
