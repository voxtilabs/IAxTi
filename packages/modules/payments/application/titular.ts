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
  // El concepto es texto libre; los montos, estados y fechas se conservan.
  const cobros = await client.query(
    `UPDATE payment_links SET concept = ''
      WHERE tenant_id = $1 AND concept <> ''
        AND (contact_id = $2 OR conversation_id = ANY($3::uuid[]))`,
    [input.tenantId, input.contactId, input.conversationIds],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'payments.titular.suprimido',
    resource: 'contact',
    resourceId: input.contactId,
    result: 'ok',
    requestId: input.requestId,
    metadata: { conceptosVaciados: cobros.rowCount ?? 0 },
  });
}
