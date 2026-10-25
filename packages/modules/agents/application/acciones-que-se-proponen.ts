import type { PoolClient } from 'pg';
import { aplicarPropuesta } from './agente-general';
import type { DepsDelAgenteGeneral } from './agente-general';
import type { AccionPropuesta } from '../domain/parser';
import { accionQueSePuedeProponer } from './acciones-en-la-conversacion';
import { resolveSuggestion, type Suggestion } from './copilot';

/**
 * La política de QUÉ se puede proponer vive aparte, en
 * `acciones-en-la-conversacion.ts`, y no por orden: `copilot` la necesita para
 * guardar, y este archivo necesita a `copilot` para marcar la sugerencia
 * enviada. Juntas en un archivo, eso era un ciclo —y lo cazó `depcruise` en el
 * preflight, no yo—.
 */
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
    `SELECT s.accion, s.conversation_id, c.contact_id
       FROM suggestions s
       JOIN conversations c ON c.id = s.conversation_id AND c.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1 AND s.id = $2 AND s.status = 'pending' AND s.expires_at >= now()`,
    [input.tenantId, input.suggestionId],
  );
  if (r.rowCount === 0) throw new Error('Esa propuesta ya no está vigente.');
  const accion = accionQueSePuedeProponer(r.rows[0].accion as AccionPropuesta | null);
  // Vuelve a pasar por la lista blanca al aplicar, no solo al guardar: la fila
  // pudo quedar de una versión en la que esa acción sí se proponía.
  if (!accion) throw new Error('Esa sugerencia no trae una acción que se pueda aplicar.');

  // Lo que el sistema sabe lo pone el sistema, PISANDO lo del modelo (#1049):
  // el contacto y la conversación son los de ESTA sugerencia — un modelo que
  // los «adivina» bien no es garantía, y uno que los adivina mal agenda a
  // otra persona. Al prompt se le dice que ni los escriba.
  const delSistema: Record<string, Record<string, unknown>> = {
    'agenda.agendar': {
      contactId: r.rows[0].contact_id,
      conversationId: r.rows[0].conversation_id,
    },
    'conversations.state': { id: r.rows[0].conversation_id },
    'payments.createLink': { conversationId: r.rows[0].conversation_id },
  };

  const ejecucion = await aplicarPropuesta(
    {
      herramienta: accion.herramienta,
      argumentos: { ...accion.argumentos, ...(delSistema[accion.herramienta] ?? {}) },
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
