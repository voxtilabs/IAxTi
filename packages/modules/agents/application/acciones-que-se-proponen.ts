import type { PoolClient } from 'pg';
import { CATALOGO } from './catalogo';
import { aplicarPropuesta } from './agente-general';
import type { DepsDelAgenteGeneral } from './agente-general';
import type { AccionPropuesta } from '../domain/parser';
import { resolveSuggestion, type Suggestion } from './copilot';

/**
 * Lo que el asistente de la bandeja puede PROPONER (#999).
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
 * El dueño apretó: se revalida todo y se ejecuta con SUS permisos.
 *
 * Llama a `aplicarPropuesta`, que es la MISMA función del Agente General —
 * revalida que la herramienta exista, que su módulo esté activo y que la
 * persona tenga el permiso, y después llama a la ruta—. Un solo camino de
 * ejecución con dos puertas de entrada; no hay un segundo con reglas propias,
 * que es justo como se filtran los agujeros (ADR-0025).
 *
 * El orden importa: primero se EJECUTA y después se marca la sugerencia como
 * enviada. Al revés, una acción que falla dejaría la sugerencia consumida y al
 * dueño sin poder volver a intentar — y lo que vio en pantalla seguiría siendo
 * verdad.
 */
export async function aplicarAccionDeLaSugerencia(
  client: PoolClient,
  input: {
    tenantId: string;
    suggestionId: string;
    permisos: ReadonlySet<string>;
    modulosActivos: ReadonlySet<string>;
  },
  deps: Pick<DepsDelAgenteGeneral, 'llamarApi'>,
): Promise<{ suggestion: Suggestion; estado: number; datos: unknown }> {
  const r = await client.query(
    `SELECT accion FROM suggestions
      WHERE tenant_id = $1 AND id = $2 AND status = 'pending' AND expires_at >= now()`,
    [input.tenantId, input.suggestionId],
  );
  if (r.rowCount === 0) throw new Error('Esa propuesta ya no está vigente.');
  const accion = accionQueSePuedeProponer(r.rows[0].accion as AccionPropuesta | null);
  // Vuelve a pasar por la lista blanca al aplicar, no solo al guardar: la fila
  // pudo quedar de una versión en la que esa acción sí se proponía.
  if (!accion) throw new Error('Esa sugerencia no trae una acción que se pueda aplicar.');

  const ejecucion = await aplicarPropuesta(
    {
      herramienta: accion.herramienta,
      argumentos: accion.argumentos,
      permisos: input.permisos,
      modulosActivos: input.modulosActivos,
    },
    deps,
  );
  if (!ejecucion.ok) {
    // La sugerencia queda PENDIENTE: el dueño puede volver a intentar cuando
    // el motivo se arregle, y el texto sigue sirviendo mientras tanto.
    const motivo = (ejecucion.datos as { message?: string })?.message;
    throw new Error(motivo ?? `No se pudo aplicar (${ejecucion.estado}).`);
  }
  const suggestion = await resolveSuggestion(client, {
    tenantId: input.tenantId,
    suggestionId: input.suggestionId,
    status: 'sent',
  });
  return { suggestion, estado: ejecucion.estado, datos: ejecucion.datos };
}
