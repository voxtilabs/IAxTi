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
): Promise<{ ejecucionesVaciadas: number }> {
  // Hay que encontrar las ejecuciones ANTES de borrar su puente (suggestions).
  // La medición se conserva; desaparece el texto que se mandó al modelo.
  const ejecuciones = await client.query(
    `UPDATE agent_executions SET input = '{}'::jsonb, output = NULL, explanation = NULL
      WHERE tenant_id = $1 AND id IN (
        SELECT execution_id FROM suggestions
         WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[])
           AND execution_id IS NOT NULL
      )`,
    [input.tenantId, input.conversationIds],
  );
  const sugerencias = await client.query(
    'DELETE FROM suggestions WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[])',
    [input.tenantId, input.conversationIds],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'agents.titular.suprimido',
    resource: 'contact',
    resourceId: input.contactId,
    result: 'ok',
    requestId: input.requestId,
    metadata: { ejecucionesVaciadas: ejecuciones.rowCount ?? 0, sugerenciasBorradas: sugerencias.rowCount ?? 0 },
  });
  return { ejecucionesVaciadas: ejecuciones.rowCount ?? 0 };
}
