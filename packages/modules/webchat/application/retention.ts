import type { PoolClient } from 'pg';

/**
 * Suelta las referencias de las sesiones antes de purgar conversaciones (#905).
 * El caller conserva la transacción y su contexto de tenant: nunca conectamos,
 * confirmamos ni borramos sesiones aquí. Un fallo revierte TODO ese lote.
 */
export async function detachSessionsFromConversations(
  client: PoolClient,
  input: { tenantId: string; conversationIds: string[] },
): Promise<void> {
  await client.query(
    `UPDATE webchat_sessions SET conversation_id = NULL, updated_at = now()
      WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[])`,
    [input.tenantId, input.conversationIds],
  );
}
