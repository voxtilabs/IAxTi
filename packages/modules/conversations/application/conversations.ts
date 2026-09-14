import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { ensureContactByPhone } from '@iaxti/module-crm';
import type { Contact } from '@iaxti/module-crm';
import { assertConversationTransition, assertDeliveryAdvance } from '../domain/state';
import type { ConversationState, DeliveryStatus } from '../domain/state';

export type Channel = 'whatsapp' | 'webchat' | 'simulador';

export type MessageType =
  | 'texto'
  | 'imagen'
  | 'audio'
  | 'documento'
  | 'ubicacion'
  | 'contacto'
  | 'plantilla'
  | 'interactivo';

export type AuthorKind = 'contact' | 'user' | 'agent' | 'system';

export interface Conversation {
  id: string;
  tenantId: string;
  contactId: string;
  channel: Channel;
  state: ConversationState;
  ownerId: string | null;
  priority: 'baja' | 'normal' | 'alta' | 'urgente';
  dealId: string | null;
  lastInboundAt: Date | null;
  lastMessageAt: Date | null;
  firstResponseAt: Date | null;
  snoozedUntil: Date | null;
  archivedAt: Date | null;
}

export interface Message {
  id: string;
  tenantId: string;
  conversationId: string;
  direction: 'in' | 'out';
  type: MessageType;
  body: string | null;
  deliveryStatus: DeliveryStatus | null;
  authorKind: AuthorKind;
  authorId: string | null;
  providerMessageId: string | null;
  createdAt: Date;
}

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    contactId: row.contact_id as string,
    channel: row.channel as Channel,
    state: row.state as ConversationState,
    ownerId: (row.owner_id as string) ?? null,
    priority: row.priority as Conversation['priority'],
    dealId: (row.deal_id as string) ?? null,
    lastInboundAt: (row.last_inbound_at as Date) ?? null,
    lastMessageAt: (row.last_message_at as Date) ?? null,
    firstResponseAt: (row.first_response_at as Date) ?? null,
    snoozedUntil: (row.snoozed_until as Date) ?? null,
    archivedAt: (row.archived_at as Date) ?? null,
  };
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    conversationId: row.conversation_id as string,
    direction: row.direction as Message['direction'],
    type: row.type as MessageType,
    body: (row.body as string) ?? null,
    deliveryStatus: (row.delivery_status as DeliveryStatus) ?? null,
    authorKind: row.author_kind as AuthorKind,
    authorId: (row.author_id as string) ?? null,
    providerMessageId: (row.provider_message_id as string) ?? null,
    createdAt: row.created_at as Date,
  };
}

async function getConversation(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  forUpdate = false,
): Promise<Conversation> {
  const r = await client.query(
    `SELECT * FROM conversations WHERE tenant_id = $1 AND id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [tenantId, conversationId],
  );
  if (r.rowCount === 0) throw new Error('No encontramos esa conversación. Puede que se haya archivado.');
  return rowToConversation(r.rows[0]);
}

export { getConversation };

export interface InboundInput {
  tenantId: string;
  phone: string;
  channel?: Channel;
  channelAccountId?: string;
  type?: MessageType;
  body?: string;
  attachments?: unknown[];
  providerMessageId?: string;
  requestId?: string;
}

export interface InboundResult {
  contact: Contact;
  contactCreated: boolean;
  conversation: Conversation;
  conversationCreated: boolean;
  reopened: boolean;
  message: Message;
}

/**
 * El camino de entrada (SPEC §10/§11): un mensaje de un teléfono desconocido
 * crea el contacto y la conversación; la oportunidad NO se crea sola. Una
 * conversación `resolved` que recibe mensaje vuelve a `open` con el mismo
 * dueño, o a `new` si no tenía. Lo llaman el simulador (#36) y los canales
 * reales (Fase 3), que antes pasan el texto por el consentimiento de crm.
 */
export async function receiveInbound(client: PoolClient, input: InboundInput): Promise<InboundResult> {
  const channel = input.channel ?? 'whatsapp';
  // El simulador imita WhatsApp; el contacto nace con el origen del canal real.
  const origin = channel === 'webchat' ? 'webchat' : 'whatsapp';
  const { contact, created: contactCreated } = await ensureContactByPhone(client, {
    tenantId: input.tenantId,
    phone: input.phone,
    origin,
    requestId: input.requestId,
  });
  const nucleo = await ingestInbound(client, { ...input, channel, contactId: contact.id });
  return { contact, contactCreated, ...nucleo };
}

interface IngestInput {
  tenantId: string;
  contactId: string;
  channel: Channel;
  channelAccountId?: string;
  type?: MessageType;
  body?: string;
  attachments?: unknown[];
  providerMessageId?: string;
  requestId?: string;
}

/** El núcleo del camino de entrada, ya con contacto resuelto. */
async function ingestInbound(
  client: PoolClient,
  input: IngestInput,
): Promise<Omit<InboundResult, 'contact' | 'contactCreated'>> {
  const channel = input.channel;
  const contact = { id: input.contactId };
  // La conversación viva del contacto en este canal; las archivadas no reviven.
  const existing = await client.query(
    `SELECT * FROM conversations
     WHERE tenant_id = $1 AND contact_id = $2 AND channel = $3 AND archived_at IS NULL
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [input.tenantId, contact.id, channel],
  );

  let conversation: Conversation;
  let conversationCreated = false;
  let reopened = false;

  if (existing.rowCount === 0) {
    const r = await client.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel, channel_account_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.tenantId, contact.id, channel, input.channelAccountId ?? null],
    );
    conversation = rowToConversation(r.rows[0]);
    conversationCreated = true;
    await publishEvent(client, {
      name: 'conversation.created',
      tenantId: input.tenantId,
      payload: { conversationId: conversation.id, contactId: contact.id, channel },
      actor: 'system',
      requestId: input.requestId,
    });
  } else {
    conversation = rowToConversation(existing.rows[0]);
    if (conversation.state === 'resolved' || conversation.state === 'snoozed') {
      // Con dueño vuelve a sus manos; sin dueño, a la cola. La disponibilidad
      // real del dueño (horarios) llega con la asignación automática (#38).
      const destino: ConversationState = conversation.ownerId ? 'open' : 'new';
      conversation = await changeConversationState(client, {
        tenantId: input.tenantId,
        conversationId: conversation.id,
        state: destino,
        actor: 'system',
        requestId: input.requestId,
      });
      reopened = true;
    }
  }

  const m = await client.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, type, body,
                           attachments, author_kind, provider_message_id)
     VALUES ($1, $2, 'in', $3, $4, $5, 'contact', $6) RETURNING *`,
    [
      input.tenantId,
      conversation.id,
      input.type ?? 'texto',
      input.body ?? null,
      JSON.stringify(input.attachments ?? []),
      input.providerMessageId ?? null,
    ],
  );
  const message = rowToMessage(m.rows[0]);
  await publishEvent(client, {
    name: 'message.received',
    tenantId: input.tenantId,
    payload: { conversationId: conversation.id, messageId: message.id, contactId: contact.id },
    actor: 'system',
    requestId: input.requestId,
  });

  conversation = await getConversation(client, input.tenantId, conversation.id);
  return { conversation, conversationCreated, reopened, message };
}

/**
 * Entrada con contacto YA resuelto (#46): el webchat identifica al
 * visitante por teléfono o correo (crm.ensureWebContact) y entra por aquí
 * al MISMO modelo y la misma bandeja.
 */
export async function receiveInboundForContact(
  client: PoolClient,
  input: IngestInput,
): Promise<Omit<InboundResult, 'contact' | 'contactCreated'>> {
  return ingestInbound(client, input);
}

export interface SendMessageInput {
  tenantId: string;
  conversationId: string;
  authorKind: Exclude<AuthorKind, 'contact'>;
  authorId?: string;
  type?: MessageType;
  body?: string;
  attachments?: unknown[];
  requestId?: string;
}

/**
 * Encola un mensaje saliente (`queued`); el canal (o el simulador) lo avanza
 * con updateDeliveryStatus. La primera respuesta humana o del agente marca
 * `first_response_at` para el SLA (#38).
 */
export async function sendMessage(client: PoolClient, input: SendMessageInput): Promise<Message> {
  const conversation = await getConversation(client, input.tenantId, input.conversationId, true);
  const m = await client.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, type, body,
                           attachments, delivery_status, author_kind, author_id)
     VALUES ($1, $2, 'out', $3, $4, $5, 'queued', $6, $7) RETURNING *`,
    [
      input.tenantId,
      conversation.id,
      input.type ?? 'texto',
      input.body ?? null,
      JSON.stringify(input.attachments ?? []),
      input.authorKind,
      input.authorId ?? null,
    ],
  );
  if (input.authorKind !== 'system') {
    await client.query(
      `UPDATE conversations SET first_response_at = COALESCE(first_response_at, now())
       WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, conversation.id],
    );
  }
  return rowToMessage(m.rows[0]);
}

/** El canal reporta el avance de entrega; publica message.sent y message.failed. */
export async function updateDeliveryStatus(
  client: PoolClient,
  input: {
    tenantId: string;
    messageId: string;
    status: DeliveryStatus;
    providerMessageId?: string;
    error?: string;
    requestId?: string;
  },
): Promise<Message> {
  const r = await client.query(
    "SELECT * FROM messages WHERE tenant_id = $1 AND id = $2 AND direction = 'out' FOR UPDATE",
    [input.tenantId, input.messageId],
  );
  if (r.rowCount === 0) throw new Error('No encontramos ese mensaje saliente.');
  const actual = rowToMessage(r.rows[0]);
  assertDeliveryAdvance(actual.deliveryStatus as DeliveryStatus, input.status);

  const u = await client.query(
    `UPDATE messages SET
       delivery_status = $3,
       provider_message_id = COALESCE($4, provider_message_id),
       meta = meta || COALESCE($5::jsonb, '{}'::jsonb)
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [
      input.tenantId,
      input.messageId,
      input.status,
      input.providerMessageId ?? null,
      input.error ? JSON.stringify({ error: input.error }) : null,
    ],
  );
  const message = rowToMessage(u.rows[0]);

  const base = { tenantId: input.tenantId, actor: 'system', requestId: input.requestId };
  if (input.status === 'sent') {
    await publishEvent(client, {
      ...base,
      name: 'message.sent',
      payload: { messageId: message.id, conversationId: message.conversationId },
    });
  }
  if (input.status === 'failed') {
    await publishEvent(client, {
      ...base,
      name: 'message.failed',
      payload: { messageId: message.id, conversationId: message.conversationId, error: input.error ?? null },
    });
  }
  return message;
}

/** Asigna dueño con historial y motivo (SPEC §11); new pasa a open. */
export async function assignConversation(
  client: PoolClient,
  input: {
    tenantId: string;
    conversationId: string;
    toOwnerId: string;
    reason?: string;
    actor?: string;
    requestId?: string;
  },
): Promise<Conversation> {
  const conversation = await getConversation(client, input.tenantId, input.conversationId, true);
  const r = await client.query(
    `UPDATE conversations SET
       owner_id = $3,
       state = CASE WHEN state = 'new' THEN 'open' ELSE state END,
       updated_at = now()
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.conversationId, input.toOwnerId],
  );
  await client.query(
    `INSERT INTO assignments (tenant_id, conversation_id, from_owner_id, to_owner_id, reason, actor)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.tenantId,
      input.conversationId,
      conversation.ownerId,
      input.toOwnerId,
      input.reason ?? null,
      input.actor ?? null,
    ],
  );
  await publishEvent(client, {
    name: 'conversation.assigned',
    tenantId: input.tenantId,
    payload: {
      conversationId: input.conversationId,
      from: conversation.ownerId,
      to: input.toOwnerId,
      reason: input.reason ?? null,
    },
    actor: input.actor,
    requestId: input.requestId,
  });
  const nueva = rowToConversation(r.rows[0]);
  if (conversation.state === 'new' && nueva.state === 'open') {
    await publishEvent(client, {
      name: 'conversation.state_changed',
      tenantId: input.tenantId,
      payload: { conversationId: input.conversationId, from: 'new', to: 'open' },
      actor: input.actor,
      requestId: input.requestId,
    });
  }
  return nueva;
}

/** Cambia el estado validando la máquina (SPEC §11); snoozed exige fecha. */
export async function changeConversationState(
  client: PoolClient,
  input: {
    tenantId: string;
    conversationId: string;
    state: ConversationState;
    snoozedUntil?: Date;
    actor?: string;
    requestId?: string;
  },
): Promise<Conversation> {
  const conversation = await getConversation(client, input.tenantId, input.conversationId, true);
  if (conversation.state === input.state) return conversation;
  assertConversationTransition(conversation.state, input.state);
  if (input.state === 'snoozed' && !input.snoozedUntil) {
    throw new Error('Para posponer dinos hasta cuándo.');
  }
  const r = await client.query(
    `UPDATE conversations SET
       state = $3,
       snoozed_until = CASE WHEN $3 = 'snoozed' THEN $4::timestamptz ELSE NULL END,
       owner_id = CASE WHEN $3 = 'new' THEN NULL ELSE owner_id END,
       updated_at = now()
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.conversationId, input.state, input.snoozedUntil ?? null],
  );
  await publishEvent(client, {
    name: 'conversation.state_changed',
    tenantId: input.tenantId,
    payload: { conversationId: input.conversationId, from: conversation.state, to: input.state },
    actor: input.actor,
    requestId: input.requestId,
  });
  return rowToConversation(r.rows[0]);
}

/** Los últimos mensajes de la conversación, más nuevo primero. */
export async function listMessages(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  limit = 50,
): Promise<Message[]> {
  const r = await client.query(
    `SELECT * FROM messages WHERE tenant_id = $1 AND conversation_id = $2
     ORDER BY seq DESC LIMIT $3`,
    [tenantId, conversationId, Math.min(limit, 100)],
  );
  return r.rows.map(rowToMessage);
}

/**
 * El webhook de estados del canal (#43): ubica el mensaje por el id del
 * proveedor y avanza la entrega. Meta manda estados fuera de orden y
 * repetidos: lo no-avanzable se IGNORA en silencio (no es un error).
 * El costo de Meta, cuando viene, queda en meta.costo.
 */
export async function updateDeliveryStatusByProviderId(
  client: PoolClient,
  input: {
    tenantId: string;
    providerMessageId: string;
    status: DeliveryStatus;
    error?: string;
    cost?: Record<string, unknown>;
    requestId?: string;
  },
): Promise<Message | null> {
  const r = await client.query(
    `SELECT id FROM messages
      WHERE tenant_id = $1 AND provider_message_id = $2 AND direction = 'out'`,
    [input.tenantId, input.providerMessageId],
  );
  if (r.rowCount === 0) return null; // estado de un mensaje que no es nuestro
  try {
    const message = await updateDeliveryStatus(client, {
      tenantId: input.tenantId,
      messageId: r.rows[0].id,
      status: input.status,
      error: input.error,
      requestId: input.requestId,
    });
    if (input.cost) {
      await client.query(
        `UPDATE messages SET meta = meta || jsonb_build_object('costo', $3::jsonb)
          WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, r.rows[0].id, JSON.stringify(input.cost)],
      );
    }
    return message;
  } catch {
    return null; // regresión o terminal repetido: Meta reintenta, nosotros no lloramos
  }
}

/** Lo que el worker de salida necesita para entregar un mensaje (#43). */
export async function getOutboundContext(
  client: PoolClient,
  tenantId: string,
  messageId: string,
): Promise<{
  conversationId: string;
  channel: Channel;
  channelAccountId: string | null;
  phone: string;
  body: string | null;
  type: MessageType;
} | null> {
  const r = await client.query(
    `SELECT m.conversation_id, m.body, m.type, c.channel, c.channel_account_id, k.phone
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN contacts k ON k.id = c.contact_id
      WHERE m.tenant_id = $1 AND m.id = $2 AND m.direction = 'out'`,
    [tenantId, messageId],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return {
    conversationId: row.conversation_id,
    channel: row.channel,
    channelAccountId: row.channel_account_id ?? null,
    phone: row.phone,
    body: row.body ?? null,
    type: row.type,
  };
}

/**
 * El contexto para la IA (#48, §40 palanca nº 1): los últimos N mensajes
 * tal cual + el RESUMEN RODANTE del resto — nunca el hilo completo.
 */
export async function getContext(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  lastN = 8,
): Promise<{
  contact: { id: string; name: string | null; phone: string | null };
  state: ConversationState;
  summary: string | null;
  summarySeq: number | null;
  /** Mensajes viejos SIN resumir aún (para refrescar el resumen). */
  unsummarized: number;
  lastMessages: Array<{ direction: 'in' | 'out'; body: string | null; seq: number }>;
}> {
  const conv = await client.query(
    `SELECT c.state, c.summary, c.summary_seq, k.id AS contact_id, k.name, k.phone
       FROM conversations c JOIN contacts k ON k.id = c.contact_id
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, conversationId],
  );
  if (conv.rowCount === 0) throw new Error('No encontramos esa conversación. Puede que se haya archivado.');
  const row = conv.rows[0];
  const ultimos = await client.query(
    `SELECT direction, COALESCE(body, transcription) AS body, seq FROM messages
      WHERE tenant_id = $1 AND conversation_id = $2
      ORDER BY seq DESC LIMIT $3`,
    [tenantId, conversationId, lastN],
  );
  const minSeq = ultimos.rows.at(-1)?.seq ?? null;
  const sinResumir = minSeq === null
    ? { rows: [{ n: 0 }] }
    : await client.query(
        `SELECT count(*)::int AS n FROM messages
          WHERE tenant_id = $1 AND conversation_id = $2
            AND seq < $3 AND seq > COALESCE($4, 0)`,
        [tenantId, conversationId, minSeq, row.summary_seq],
      );
  return {
    contact: { id: row.contact_id, name: row.name ?? null, phone: row.phone ?? null },
    state: row.state,
    summary: row.summary ?? null,
    summarySeq: row.summary_seq === null ? null : Number(row.summary_seq),
    unsummarized: sinResumir.rows[0].n,
    lastMessages: ultimos.rows.reverse().map((m) => ({
      direction: m.direction,
      body: m.body ?? null,
      seq: Number(m.seq),
    })),
  };
}

/** Guarda el resumen rodante hasta `seq` (lo escribe el copiloto, #48). */
export async function updateSummary(
  client: PoolClient,
  input: { tenantId: string; conversationId: string; summary: string; seq: number },
): Promise<void> {
  await client.query(
    `UPDATE conversations SET summary = $3, summary_seq = $4, updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.conversationId, input.summary, input.seq],
  );
}

/** La transcripción del audio queda como texto BUSCABLE (#48; el índice
 *  de búsqueda de #39 ya la incluye). */
export async function updateTranscription(
  client: PoolClient,
  input: { tenantId: string; messageId: string; transcription: string },
): Promise<void> {
  await client.query(
    `UPDATE messages SET transcription = $3
      WHERE tenant_id = $1 AND id = $2 AND type = 'audio'`,
    [input.tenantId, input.messageId, input.transcription],
  );
}

/**
 * Pedir humano (#49): publica `conversation.handoff_requested` y, si la
 * regla del tenant nombra a alguien, asigna. Sin regla queda en la cola
 * (owner null) para que el equipo la tome. La llama el copiloto al escalar
 * y también sirve para el "quiero hablar con una persona" del cliente.
 */
export async function requestHandoff(
  client: PoolClient,
  input: {
    tenantId: string;
    conversationId: string;
    toOwnerId?: string | null;
    reason: string;
    actor: string;
    requestId?: string;
  },
): Promise<void> {
  if (input.toOwnerId) {
    await assignConversation(client, {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      toOwnerId: input.toOwnerId,
      reason: input.reason,
      actor: input.actor,
      requestId: input.requestId,
    });
  }
  await publishEvent(client, {
    name: 'conversation.handoff_requested',
    tenantId: input.tenantId,
    payload: {
      conversationId: input.conversationId,
      toOwnerId: input.toOwnerId ?? null,
      reason: input.reason,
    },
    actor: input.actor,
    requestId: input.requestId,
  });
}
