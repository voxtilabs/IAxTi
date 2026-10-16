import type { PoolClient } from 'pg';
import { writeAudit } from '@iaxti/module-audit';

/** Supresión del titular (#903). Usa la transacción de CRM; nunca abre ni confirma otra. */
export async function suprimirDatosDelTitular(
  client: PoolClient,
  input: {
    tenantId: string;
    contactId: string;
    conversationIds: string[];
    actor: string;
    requestId?: string;
  },
): Promise<void> {
  // Este borrado ya formaba parte de la supresión, mediante SQL dinámico en CRM.
  const muestras = await client.query(
    'DELETE FROM response_samples WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[])',
    [input.tenantId, input.conversationIds],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'analytics.titular.suprimido',
    resource: 'contact',
    resourceId: input.contactId,
    result: 'ok',
    requestId: input.requestId,
    metadata: { muestrasBorradas: muestras.rowCount ?? 0 },
  });
}
