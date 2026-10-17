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
  const entregas = await client.query(
    `UPDATE webhook_deliveries SET payload = '{}'::jsonb, response_body = NULL
      WHERE tenant_id = $1
        AND (payload::text LIKE '%' || $2::text || '%'
             OR ($3::uuid[] <> '{}'::uuid[] AND payload::text ~ ANY(SELECT unnest($3::uuid[])::text)))`,
    [input.tenantId, input.contactId, input.conversationIds],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'integrations.titular.suprimido',
    resource: 'contact',
    resourceId: input.contactId,
    result: 'ok',
    requestId: input.requestId,
    metadata: { entregasVaciadas: entregas.rowCount ?? 0 },
  });
}
