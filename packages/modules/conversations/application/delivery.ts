import type { PoolClient } from 'pg';
import { retryExhaustedEvent } from '@iaxti/core';
import { writeAudit, type ActorKind } from '@iaxti/module-audit';

/** Conflicto de negocio; los errores de infraestructura deben seguir siendo 500. */
export class OutboundRetryError extends Error {}

/** No recrea ni reenvía mensajes entregados; recupera únicamente el pedido durable agotado. */
export async function retryOutboundDelivery(
  client: PoolClient,
  input: {
    tenantId: string; conversationId: string; messageId: string;
    actor: string; actorKind: ActorKind; requestId?: string;
  },
): Promise<{ messageId: string }> {
  const m = await client.query(
    `SELECT id, delivery_status FROM messages
      WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3 AND direction='out' FOR UPDATE`,
    [input.tenantId, input.conversationId, input.messageId],
  );
  if (!m.rowCount) throw new OutboundRetryError('No encontramos ese mensaje en esta conversación.');
  if (m.rows[0].delivery_status !== 'queued') throw new OutboundRetryError('Solo se recuperan mensajes pendientes de despacho.');
  const messageId = m.rows[0].id as string;
  const eventId = await retryExhaustedEvent(client, {
    tenantId: input.tenantId, name: 'message.delivery_requested', payload: { messageId },
  });
  if (eventId === null) throw new OutboundRetryError('Este mensaje no tiene un pedido de despacho agotado.');
  await writeAudit(client, {
    tenantId: input.tenantId, actor: input.actor, actorKind: input.actorKind,
    action: 'message.delivery_retried', resource: 'message', resourceId: messageId,
    requestId: input.requestId, result: 'success', metadata: { eventId, conversationId: input.conversationId },
  });
  return { messageId };
}
