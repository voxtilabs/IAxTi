import { readFileSync } from 'node:fs';
import { archivosFuente } from './testing/archivos';
import { fuenteLimpia } from './testing/fuente-limpia';

/**
 * Eventos declarados en un manifiesto que NADIE emite.
 *
 * ## Por qué este escáner, si ya había una guarda
 *
 * La había, y estaba verde con dos eventos huérfanos puestos. Preguntaba
 * `codigo.includes("'" + evento + "'")` sobre todo el repo concatenado, así
 * que **cualquier** mención entre comillas la satisfacía. Las dos que la
 * engañaron son las dos formas en que este repo nombra un evento sin
 * emitirlo:
 *
 *  - `event: 'tenant.plan_changed'` — el registro del CONSUMIDOR. El
 *    manifiesto de `organizations` pasaba gracias a una línea de
 *    `conversations`: el que espera el evento era la prueba de que alguien lo
 *    manda.
 *  - `action: 'permission.denied'` — una escritura de auditoría, más dos
 *    `WHERE action = 'permission.denied'` del panel de seguridad. El evento
 *    no existe; existe la acción que se llama igual.
 *
 * Y el daño no es que la guarda no sirviera: es que **afirmaba**. Un evento
 * sin productor y sin excepción anotada se leía como «tiene quien lo
 * publique», que es más caro que no tener guarda. El día que alguien cablee
 * el emisor de verdad, el color del test no cambia — nunca estuvo midiendo
 * eso. Es la forma final del defecto que perseguimos toda la semana: *cuando
 * lo declarado y no aplicado es una comprobación, el sistema no se ve roto;
 * se ve vigilado.*
 *
 * ## El criterio
 *
 * Evidencia POSITIVA, no ausencia de evidencia: el nombre del evento aparece
 * en un archivo que de verdad emite (llama a `publishEvent`), en una posición
 * que no es ninguna de las dos formas ajenas de arriba.
 *
 * El filtro por archivo solo ya descartaba a `permission.denied`: ni
 * `registrar-rechazo.ts` ni `salud.ts` publican nada. (Ese ya no llega hasta
 * acá: #793 lo sacó de `events.publishes` porque no era un evento sino la
 * acción de auditoría del mismo nombre, y lo que esta guarda recibe son los
 * declarados. El ejemplo se queda escrito porque la acción sigue existiendo y
 * el criterio tiene que seguir distinguiéndola si alguien vuelve a
 * declararla.) La posición hace falta para `tenant.plan_changed`, porque
 * `retention.ts` —donde vive el registro del consumidor— sí publica otros
 * eventos.
 *
 * ## Por qué no se exige `name: '<evento>'`
 *
 * Porque seis eventos reales se emiten a través de un mapa, no con el nombre
 * escrito al lado de `name:`:
 *
 * ```ts
 * const EVENTO_POR_ESTADO = { active: 'channel.connected', … };
 * await publishEvent(client, { name: EVENTO_POR_ESTADO[estado], … });
 * ```
 *
 * Los tres `channel.*` y los tres `appointment.*` salen así. Exigir la forma
 * directa los habría acusado a los seis, y seis falsos huérfanos en una
 * guarda nueva es el camino conocido a que se relaje la expresión y después
 * se borre el archivo. Medido antes de elegir el criterio: con la forma
 * directa, 12 huérfanos de 78 declarados, 6 de ellos falsos; con éste, 2 de
 * 78, los 2 reales.
 */

/** Las dos formas con las que este repo NOMBRA un evento sin emitirlo. */
const MENCION_AJENA = /(?:\bevent|\baction)\s*(?::|={1,3})\s*$/;

/** Un archivo que no llama a `publishEvent` no emite nada, diga lo que diga. */
const EMITE = /\bpublishEvent\s*\(/;

export interface ArchivoFuente {
  ruta: string;
  texto: string;
}

/**
 * Para cada evento, el archivo donde se lo encontró emitiendo. Lo que no está
 * en el mapa, no lo emite nadie.
 *
 * Devuelve el archivo y no un booleano a propósito: cuando esta guarda se
 * pone roja, la pregunta siguiente es siempre «¿y quién lo manda hoy?», y la
 * respuesta tiene que venir en el mensaje y no en un `grep` a mano.
 */
export function emisoresDeEventos(
  archivos: ArchivoFuente[],
  declarados: string[],
): Map<string, string> {
  const encontrados = new Map<string, string>();
  for (const { ruta, texto } of archivos) {
    const limpio = fuenteLimpia(texto);
    if (!EMITE.test(limpio)) continue;
    for (const evento of declarados) {
      if (encontrados.has(evento)) continue;
      const comillado = `'${evento}'`;
      let desde = 0;
      for (;;) {
        const i = limpio.indexOf(comillado, desde);
        if (i === -1) break;
        if (!MENCION_AJENA.test(limpio.slice(Math.max(0, i - 24), i))) {
          encontrados.set(evento, ruta);
          break;
        }
        desde = i + comillado.length;
      }
    }
  }
  return encontrados;
}

/** Los `declarados` que ningún archivo bajo `raices` emite. */
export function eventosSinEmisor(raices: string[], declarados: string[]): string[] {
  const archivos = raices
    .flatMap((r) => archivosFuente(r))
    .map((ruta) => ({ ruta, texto: readFileSync(ruta, 'utf8') }));
  const emisores = emisoresDeEventos(archivos, declarados);
  return declarados.filter((e) => !emisores.has(e));
}
