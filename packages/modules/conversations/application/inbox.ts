import type { PoolClient } from 'pg';
import type { ConversationState } from '../domain/state';
import type { Channel, Conversation } from './conversations';
import { RANGO_SQL, rangoDePrioridad, type Prioridad } from '../domain/prioridad';

// La bandeja (SPEC §11): lista con filtros, vista "sin responder" y la ficha
// mínima del contacto. El orden y los índices son los de §39. "Sin responder"
// es exacto gracias al trigger: el último mensaje fue entrante ⟺
// last_inbound_at = last_message_at.

export interface InboxItem extends Conversation {
  contactName: string | null;
  /** null para quien llegó sin teléfono: webchat (#46), Instagram y Messenger (#74). */
  contactPhone: string | null;
  /** Identidad en el canal de la conversación, cuando no hay teléfono. */
  contactIdentity: string | null;
  /** Segundos esperando respuesta; null si el último mensaje fue del negocio. */
  unansweredSeconds: number | null;
}

export interface InboxFilters {
  state?: ConversationState;
  channel?: Channel;
  /** Solo las de este dueño… */
  ownerId?: string;
  /** …o las suyas MÁS las sin dueño (USER sin read_all: puede tomar de la cola). */
  ownerIdOrUnassigned?: string;
  /** Historia de UN contacto (la ficha #32): incluye resueltas y archivadas. */
  contactId?: string;
  view?: 'sin_responder';
  /**
   * Solo las de esta prioridad (#550).
   *
   * El día de una promoción, con doscientas conversaciones abiertas, «muéstrame
   * las urgentes» es la diferencia entre atender por orden de llegada y atender
   * al que reclama.
   */
  prioridad?: Prioridad;
  cursor?: string;
  limit?: number;
}

function rowToItem(row: Record<string, unknown>): InboxItem {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    contactId: row.contact_id as string,
    channel: row.channel as Channel,
    state: row.state as ConversationState,
    ownerId: (row.owner_id as string) ?? null,
    priority: row.priority as InboxItem['priority'],
    dealId: (row.deal_id as string) ?? null,
    lastInboundAt: (row.last_inbound_at as Date) ?? null,
    lastMessageAt: (row.last_message_at as Date) ?? null,
    firstResponseAt: (row.first_response_at as Date) ?? null,
    snoozedUntil: (row.snoozed_until as Date) ?? null,
    archivedAt: (row.archived_at as Date) ?? null,
    contactName: (row.contact_name as string) ?? null,
    contactPhone: (row.contact_phone as string) ?? null,
    contactIdentity: (row.contact_identity as string) ?? null,
    unansweredSeconds: row.unanswered_seconds === null ? null : Number(row.unanswered_seconds),
  };
}

/**
 * El cursor lleva TRES valores desde #550: rango, fecha e id.
 *
 * El keyset tiene que comparar exactamente las mismas columnas que el `ORDER
 * BY`. Al meter la prioridad delante de la fecha y dejar el cursor con dos,
 * la segunda página habría empezado desde una fecha sin mirar el rango: se
 * saltarían conversaciones urgentes y se repetirían otras, y en una lista
 * paginada eso no se nota mirando — se nota cuando alguien no fue atendido.
 *
 * Un cursor viejo de dos partes se rechaza con el mensaje que ya existía. Es
 * una pestaña abierta durante el despliegue: se vuelve a la primera página y
 * listo.
 */
function encodeCursor(rango: number, sortValue: Date, id: string): string {
  return Buffer.from(`${rango}|${sortValue.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { rango: string; sortValue: string; id: string } {
  const partes = Buffer.from(cursor, 'base64url').toString().split('|');
  const [rango, sortValue, id] = partes;
  if (partes.length !== 3 || !rango || !sortValue || !id) {
    throw new Error('Ese cursor no es válido. Vuelve a la primera página.');
  }
  return { rango, sortValue, id };
}

/**
 * Lista para la bandeja. Orden por defecto: actividad reciente primero
 * (índice tenant/state/last_message_at de §39). Vista `sin_responder`:
 * la que más tiempo lleva esperando primero.
 */
/**
 * ¿Hubo alguna conversación con un mensaje? (#495)
 *
 * Existe porque el paso «primera conversación» del onboarding es OBLIGATORIO
 * y no tenía verificador: salía siempre del historial de la columna, que no
 * retrocede — así que nunca podía aparecer como desfase, y el producto podía
 * mostrar ese check en verde sobre un negocio que jamás recibió un mensaje.
 *
 * Cuenta las archivadas y las resueltas a propósito: la pregunta es si el
 * negocio ya usó la bandeja alguna vez, no si tiene trabajo pendiente hoy.
 */
export async function huboAlgunaConversacion(
  client: PoolClient,
  tenantId: string,
): Promise<{ conversaciones: number; ultimoMensajeEl: Date | null }> {
  const r = await client.query(
    `SELECT count(*)::int AS n, max(last_message_at) AS ultimo
       FROM conversations
      WHERE tenant_id = $1 AND last_message_at IS NOT NULL`,
    [tenantId],
  );
  return {
    conversaciones: Number(r.rows[0].n),
    ultimoMensajeEl: (r.rows[0].ultimo as Date) ?? null,
  };
}

export async function listInbox(
  client: PoolClient,
  tenantId: string,
  filters: InboxFilters = {},
): Promise<{ items: InboxItem[]; nextCursor: string | null }> {
  const limit = Math.min(filters.limit ?? 25, 100);
  const params: unknown[] = [tenantId];
  const where: string[] = ['c.tenant_id = $1'];

  if (filters.contactId) {
    // La ficha muestra TODA la historia: archivadas y resueltas incluidas.
    params.push(filters.contactId);
    where.push(`c.contact_id = $${params.length}`);
  } else {
    where.push('c.archived_at IS NULL');
  }
  if (filters.state) {
    params.push(filters.state);
    where.push(`c.state = $${params.length}`);
  } else if (!filters.contactId) {
    where.push(`c.state <> 'resolved'`);
  }
  if (filters.channel) {
    params.push(filters.channel);
    where.push(`c.channel = $${params.length}`);
  }
  if (filters.ownerId) {
    params.push(filters.ownerId);
    where.push(`c.owner_id = $${params.length}`);
  }
  if (filters.ownerIdOrUnassigned) {
    params.push(filters.ownerIdOrUnassigned);
    where.push(`(c.owner_id = $${params.length} OR c.owner_id IS NULL)`);
  }
  if (filters.prioridad) {
    params.push(filters.prioridad);
    where.push(`c.priority = $${params.length}`);
  }

  const sinResponder = filters.view === 'sin_responder';
  if (sinResponder) {
    where.push('c.last_inbound_at IS NOT NULL', 'c.last_inbound_at = c.last_message_at');
  } else {
    where.push('c.last_message_at IS NOT NULL');
  }

  // Keyset sobre la columna de orden + id, sin OFFSET (SPEC §28).
  const sortCol = sinResponder ? 'c.last_inbound_at' : 'c.last_message_at';
  const direction = sinResponder ? 'ASC' : 'DESC';
  // La prioridad va PRIMERO (#550), también en `sin_responder`: una urgente que
  // lleva veinte minutos esperando importa más que una normal que lleva dos
  // horas, y la vista de «sin responder» es exactamente donde se decide a quién
  // se atiende ahora.
  //
  // DESC siempre para el rango: lo urgente arriba, en las dos vistas. Que la
  // fecha cambie de sentido entre vistas no cambia qué es urgente.
  if (filters.cursor) {
    const { rango, sortValue, id } = decodeCursor(filters.cursor);
    params.push(rango, sortValue, id);
    const cmp = sinResponder ? '>' : '<';
    // El rango va al revés que la fecha: para seguir avanzando en DESC de
    // rango, lo que viene después es rango MENOR — o el mismo rango con la
    // fecha avanzando en el sentido de la vista.
    where.push(
      `((${RANGO_SQL}) < $${params.length - 2}::int
        OR ((${RANGO_SQL}) = $${params.length - 2}::int
            AND (${sortCol}, c.id) ${cmp} ($${params.length - 1}::timestamptz, $${params.length}::uuid)))`,
    );
  }

  params.push(limit + 1);
  const r = await client.query(
    `SELECT c.*, k.name AS contact_name, k.phone AS contact_phone,
            (SELECT i.identity FROM contact_identities i
              WHERE i.tenant_id = c.tenant_id AND i.contact_id = k.id AND i.channel = c.channel
              LIMIT 1) AS contact_identity,
            CASE WHEN c.last_inbound_at = c.last_message_at
                 THEN floor(extract(epoch FROM now() - c.last_inbound_at))
                 ELSE NULL END AS unanswered_seconds
       FROM conversations c
       JOIN contacts k ON k.id = c.contact_id
      WHERE ${where.join(' AND ')}
      ORDER BY (${RANGO_SQL}) DESC, ${sortCol} ${direction}, c.id ${direction}
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  const items = rows.map(rowToItem);
  const last = rows.at(-1);
  const nextCursor = hasMore && last
    ? encodeCursor(
        rangoDePrioridad(last.priority as string | null),
        (sinResponder ? last.last_inbound_at : last.last_message_at) as Date,
        last.id as string,
      )
    : null;
  return { items, nextCursor };
}

export interface ConversationDetail extends InboxItem {
  contactEmail: string | null;
  contactOptInAt: Date | null;
  contactOptInChannel: string | null;
  contactOptInEvidence: string | null;
  contactOptedOutAt: Date | null;
}

/** La conversación con la ficha mínima del contacto (el panel derecho). */
export async function getConversationDetail(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  const r = await client.query(
    `SELECT c.*, k.name AS contact_name, k.phone AS contact_phone,
            (SELECT i.identity FROM contact_identities i
              WHERE i.tenant_id = c.tenant_id AND i.contact_id = k.id AND i.channel = c.channel
              LIMIT 1) AS contact_identity,
            k.email AS contact_email, k.opt_in_at AS contact_opt_in_at,
            -- Por qué canal consintió, y con qué evidencia (#696). Se guardaban
            -- desde el principio y esta consulta pedía solo la fecha, así que la
            -- ficha decía «dio su consentimiento» sin poder decir a qué.
            k.opt_in_channel AS contact_opt_in_channel,
            k.opt_in_evidence AS contact_opt_in_evidence,
            k.opted_out_at AS contact_opted_out_at,
            CASE WHEN c.last_inbound_at = c.last_message_at
                 THEN floor(extract(epoch FROM now() - c.last_inbound_at))
                 ELSE NULL END AS unanswered_seconds
       FROM conversations c
       JOIN contacts k ON k.id = c.contact_id
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, conversationId],
  );
  if (r.rowCount === 0) throw new Error('No encontramos esa conversación. Puede que se haya archivado.');
  const row = r.rows[0];
  return {
    ...rowToItem(row),
    contactEmail: (row.contact_email as string) ?? null,
    contactOptInAt: (row.contact_opt_in_at as Date) ?? null,
    contactOptInChannel: (row.contact_opt_in_channel as string) ?? null,
    contactOptInEvidence: (row.contact_opt_in_evidence as string) ?? null,
    contactOptedOutAt: (row.contact_opted_out_at as Date) ?? null,
  };
}
