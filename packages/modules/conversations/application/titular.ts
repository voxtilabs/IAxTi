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
): Promise<{ mensajesBorrados: number }> {
  const mensajes = await client.query(
    'DELETE FROM messages WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[])',
    [input.tenantId, input.conversationIds],
  );
  const notas = await client.query(
    'DELETE FROM internal_notes WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[])',
    [input.tenantId, input.conversationIds],
  );
  // La fila queda vacía y archivada: conserva el rastro del trato.
  //
  // `last_message_preview` va acá por lo mismo que `summary`: las dos son
  // copias derivadas del contenido del cliente, y el derecho de supresión
  // borra el contenido en TODAS las tablas donde vivía. Una copia que se
  // queda atrás no se nota —la conversación se ve vacía igual— hasta que
  // alguien mira la lista y ahí sigue la última frase que la persona pidió
  // borrar.
  const conversaciones = await client.query(
    `UPDATE conversations SET summary = NULL, last_message_preview = NULL,
            archived_at = COALESCE(archived_at, now())
      WHERE tenant_id = $1 AND contact_id = $2 AND id = ANY($3::uuid[])`,
    [input.tenantId, input.contactId, input.conversationIds],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'conversations.titular.suprimido',
    resource: 'contact',
    resourceId: input.contactId,
    result: 'ok',
    requestId: input.requestId,
    metadata: { mensajesBorrados: mensajes.rowCount ?? 0, notasBorradas: notas.rowCount ?? 0, conversacionesArchivadas: conversaciones.rowCount ?? 0 },
  });
  return { mensajesBorrados: mensajes.rowCount ?? 0 };
}

/** Lee los ids y las llaves ANTES de vaciar mensajes. CRM conserva el lock del contacto. */
export async function datosParaSuprimirTitular(
  client: PoolClient,
  input: { tenantId: string; contactId: string },
): Promise<{ conversationIds: string[]; adjuntosR2: string[] }> {
  const conversaciones = await client.query(
    'SELECT id FROM conversations WHERE tenant_id = $1 AND contact_id = $2 FOR UPDATE',
    [input.tenantId, input.contactId],
  );
  const conversationIds = conversaciones.rows.map((r) => r.id as string);
  const adjuntos = await client.query(
    `SELECT jsonb_array_elements(attachments)->>'key' AS key FROM messages
      WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[])
        AND jsonb_array_length(attachments) > 0`,
    [input.tenantId, conversationIds],
  );
  return { conversationIds, adjuntosR2: adjuntos.rows.filter((r) => r.key).map((r) => r.key as string) };
}

/** Contenido propio para el derecho de acceso/portabilidad, en la transacción de CRM. */
export async function exportarDatosDelTitular(
  client: PoolClient,
  input: { tenantId: string; contactId: string },
): Promise<{ conversaciones: Array<Record<string, unknown>>; mensajes: Array<Record<string, unknown>> }> {
  const params = [input.tenantId, input.contactId];
  const conversaciones = await client.query(
    'SELECT * FROM conversations WHERE tenant_id = $1 AND contact_id = $2',
    params,
  );
  const mensajes = await client.query(
    `SELECT m.* FROM messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1 AND c.contact_id = $2
      ORDER BY m.created_at`,
    params,
  );
  return { conversaciones: conversaciones.rows, mensajes: mensajes.rows };
}
