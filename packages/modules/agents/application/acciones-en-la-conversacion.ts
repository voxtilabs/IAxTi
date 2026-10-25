import { CATALOGO } from './catalogo';
import type { AccionPropuesta } from '../domain/parser';

/**
 * Lo que el asistente de la bandeja puede PROPONER (#1000).
 *
 * ## Por qué esta lista y no el catálogo entero
 *
 * El catálogo del Agente General marca 104 de sus 222 herramientas como
 * `confirmar`, y ahí están las de plataforma, facturación, identidad y
 * configuración de agentes. Ese catálogo es para el dueño hablándole al
 * maestro: él puede pedir cualquier cosa de su negocio.
 *
 * Esto es otra cosa: un asistente dentro de una conversación con un CLIENTE.
 * Lo único que tiene sentido que proponga es lo que ESA conversación puede
 * necesitar — lo que el cliente acaba de pedir. Que el catálogo diga
 * `confirmar` es condición necesaria y no suficiente.
 *
 * ## Por qué `conversations.reply` NO está
 *
 * Porque ya existe y se llama sugerencia. El texto de la respuesta es
 * `suggestions.text` desde #48, con su 👍/👎 y su botón de enviar. Agregarla
 * acá serían dos mecanismos para lo mismo, y el segundo siempre queda a medias.
 *
 * ## El criterio, en una frase
 *
 * El cliente pidió algo concreto que no se resuelve contestando. Si se
 * resuelve contestando, es texto; si hace falta tocar el negocio, es acción.
 */
export const ACCIONES_EN_LA_CONVERSACION: Record<string, string> = {
  'agenda.agendar':
    'El cliente pidió una hora. Es lo que más se pide y lo que hoy obliga a que una ' +
    'persona abra la agenda mientras el cliente espera.',
  'agenda.mover':
    'Pidió cambiarla. Mover es una sola acción con su hueco comprobado; cancelar y volver ' +
    'a agendar le manda dos correos.',
  'agenda.estado':
    'Avisó que no va a poder ir. Cancelar a tiempo libera la hora para otro, y el valor de ' +
    'eso se pierde si espera a que alguien lea el mensaje.',
  'conversations.state':
    'Quedó resuelto, o pidió que lo retomen después. Es el estado de SU conversación y lo ' +
    'dijo él; hoy queda abierta hasta que alguien la cierre a mano.',
  'payments.createLink':
    'Dijo que quiere pagar. El link sale del monto de la oportunidad, así que no hay nada ' +
    'que escribir: hay que decidir que sí.',
  'deals.move':
    'Lo que dijo mueve la oportunidad de etapa —ganada, perdida, o un paso más—. Sin esto ' +
    'el embudo cuenta mal y las métricas del dueño mienten.',
};

/**
 * La acción, si es una de las que se pueden proponer y el catálogo sigue
 * pidiendo visto bueno para ella.
 *
 * Las dos condiciones, y la segunda no es redundante: si alguien marcara una
 * de estas como `libre` en el catálogo curado, acá SEGUIRÍA pidiendo el visto
 * bueno. Un asistente hablando con un cliente no hereda la autonomía que el
 * dueño se dio para sí mismo.
 *
 * Devuelve `null` en vez de lanzar: el modelo propuso algo que no corresponde,
 * y perder la respuesta entera por eso sería cambiar un problema chico por uno
 * grande. Queda el texto, que es lo que necesita quien atiende.
 */
export function accionQueSePuedeProponer(accion: AccionPropuesta | null): AccionPropuesta | null {
  if (!accion) return null;
  if (!(accion.herramienta in ACCIONES_EN_LA_CONVERSACION)) return null;
  const h = CATALOGO.find((x) => x.nombre === accion.herramienta);
  if (!h || h.trato !== 'confirmar') return null;
  return accion;
}

/**
 * Los ARGUMENTOS que el modelo debe dar por acción (#1049), curados a mano.
 *
 * Sin esto, el modelo inventaba campos razonables («fecha_hora»: «próximo
 * jueves 16:00») que la ruta rechazaba — medido: el botón Confirmar fallaba
 * el 100 % de las veces con «La cita necesita contacto, inicio y fin». Acá
 * va SOLO lo que el modelo puede saber; lo que el sistema sabe mejor (el
 * contacto de la conversación, el id de la conversación) lo pone
 * `aplicarAccionDeLaSugerencia` al aplicar, y no se le pide nunca.
 */
export const ARGUMENTOS_DE_LA_ACCION: Record<string, string> = {
  'agenda.agendar':
    '{"inicio": "<ISO 8601 con zona, ej 2026-10-29T16:00:00-03:00>", "fin": "<ISO, normalmente una hora después>", "title": "<el servicio, ej Corte de pelo>"}',
  'agenda.mover':
    '{"id": "<el id de la cita que se mueve, tomado del contexto>", "inicio": "<ISO 8601 con zona>", "fin": "<ISO 8601 con zona>"}',
  'agenda.estado':
    '{"id": "<el id de la cita, del contexto>", "estado": "<cancelada|confirmada>", "motivo": "<lo que dijo el cliente>"}',
  'conversations.state': '{"state": "<resolved|snoozed|open>"}',
  'payments.createLink': '{}',
  'deals.move': '{"id": "<el id de la oportunidad, del contexto>", "stageId": "<la etapa de destino, del contexto>"}',
};

/**
 * El catálogo de acciones proponibles, EN EL PROMPT (#1020).
 *
 * Hasta esto, «una de las que te pasaron» del formato de sugerencia no
 * refería a nada: las tools que viajan al modelo son las de LECTURA (#240), y
 * esta lista solo filtraba DESPUÉS. El modelo proponía a ciegas —tenía que
 * adivinar el nombre exacto `agenda.agendar`— y el filtro se comía el resto.
 * Una capacidad que el modelo no sabe que tiene es una capacidad que no
 * existe.
 *
 * Se filtra por módulos activos: proponer un link de pago con pagos apagado
 * es proponer un botón que va a fallar. Sin módulos declarados (quien llama
 * no los sabe) se ofrecen todas las válidas: el filtro de aplicar (#1000)
 * revalida módulo y permiso igual, así que lo peor es una propuesta que el
 * dueño no puede confirmar — nunca una acción ejecutada de más.
 */
export function accionesParaElPrompt(activeModules?: readonly string[]): string | null {
  const lineas = Object.keys(ACCIONES_EN_LA_CONVERSACION)
    .map((nombre) => CATALOGO.find((x) => x.nombre === nombre))
    .filter((h): h is NonNullable<typeof h> => h !== undefined && h.trato === 'confirmar')
    .filter((h) => !h.modulo || !activeModules || activeModules.includes(h.modulo))
    .map((h) => {
      const args = ARGUMENTOS_DE_LA_ACCION[h.nombre];
      return `- ${h.nombre}: ${h.descripcion}${args ? `\n  argumentos: ${args}` : ''}`;
    });
  if (!lineas.length) return null;
  return `Acciones que puedes PROPONER en "accion" (no las ejecutas tú: quedan esperando el visto bueno de quien atiende). Los argumentos van EXACTAMENTE con estos campos — el contacto y la conversación los pone el sistema, no los escribas:
${lineas.join('\n')}`;
}

/**
 * La acción en palabras, para que la bandeja no muestre `agenda.agendar`.
 *
 * El texto sale de la DESCRIPCIÓN del catálogo, que es lo único de ese
 * inventario que escribe una persona. Escribirlo otra vez en el front serían
 * dos copias de la misma frase, y la del front envejecería sola.
 */
export function accionEnPalabras(accion: AccionPropuesta | null): string | null {
  const valida = accionQueSePuedeProponer(accion);
  if (!valida) return null;
  return CATALOGO.find((x) => x.nombre === valida.herramienta)?.descripcion ?? null;
}
