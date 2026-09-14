import type { PoolClient } from 'pg';
import type { EventEnvelope } from '@iaxti/core';

/**
 * Consumidor de contact.merged (#34): las conversaciones del duplicado se
 * re-apuntan al principal — ambas historias quedan bajo un solo contacto.
 * Lo registra workers en el despachador; idempotente por processed_events.
 */
export async function onContactMerged(event: EventEnvelope, client: PoolClient): Promise<void> {
  const { primaryId, duplicateId } = event.payload as { primaryId: string; duplicateId: string };
  if (!primaryId || !duplicateId) return;
  await client.query(
    'UPDATE conversations SET contact_id = $3, updated_at = now() WHERE tenant_id = $1 AND contact_id = $2',
    [event.tenantId, duplicateId, primaryId],
  );
}
