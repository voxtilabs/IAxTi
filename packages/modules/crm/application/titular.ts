import type { PoolClient } from 'pg';
import { writeAudit } from '@iaxti/module-audit';

// Derechos del titular, Ley 21.719 (#81, SPEC §19). Dos derechos que el
// negocio tiene que poder ejercer sin llamarnos: acceso/portabilidad y
// supresión.
//
// La decisión de fondo: **supresión es anonimizar el contacto y borrar el
// contenido, NO borrar la fila**. Borrar la fila se lleva por delante la
// oportunidad, la factura y la trazabilidad contable, que el negocio está
// obligado a conservar. Lo que desaparece es la persona: nombre, teléfono,
// correo, RUT, identidades de canal y el contenido de sus mensajes.
//
// El libro de auditoría NO se toca: es la evidencia de que la supresión
// ocurrió, y sin ella no hay cómo demostrarlo ante quien lo pregunte.

export interface ExportacionTitular {
  contacto: Record<string, unknown>;
  identidades: Array<Record<string, unknown>>;
  conversaciones: Array<Record<string, unknown>>;
  mensajes: Array<Record<string, unknown>>;
  actividades: Array<Record<string, unknown>>;
  oportunidades: Array<Record<string, unknown>>;
  generadoEl: string;
}

/**
 * Todo lo que tenemos de una persona, en un JSON que se le puede entregar.
 * Incluye el contenido de sus mensajes porque también son suyos.
 */
export async function exportarTitular(
  client: PoolClient,
  input: { tenantId: string; contactId: string; actor: string; requestId?: string },
): Promise<ExportacionTitular> {
  const uno = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows;

  const contacto = await uno('SELECT * FROM contacts WHERE tenant_id = $1 AND id = $2', [
    input.tenantId,
    input.contactId,
  ]);
  if (contacto.length === 0) throw new Error('No encontramos a esa persona en este negocio.');

  // En SERIE, no en paralelo: un cliente de pg atiende una consulta a la vez
  // y dispararlas juntas sobre el mismo cliente es pedir una carrera.
  const par = [input.tenantId, input.contactId];
  const identidades = await uno(
    'SELECT channel, identity, created_at FROM contact_identities WHERE tenant_id = $1 AND contact_id = $2',
    par,
  );
  const conversaciones = await uno(
    'SELECT * FROM conversations WHERE tenant_id = $1 AND contact_id = $2',
    par,
  );
  const mensajes = await uno(
    `SELECT m.* FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.tenant_id = $1 AND c.contact_id = $2
      ORDER BY m.created_at`,
    par,
  );
  const actividades = await uno(
    'SELECT * FROM activities WHERE tenant_id = $1 AND contact_id = $2',
    par,
  ).catch(() => []);
  const oportunidades = await uno(
    'SELECT * FROM deals WHERE tenant_id = $1 AND contact_id = $2',
    par,
  ).catch(() => []);

  // El ejercicio del derecho también se audita: quién pidió qué y cuándo.
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'titular.exportado',
    resource: 'contact',
    resourceId: input.contactId,
    result: 'ok',
    requestId: input.requestId,
    metadata: { mensajes: mensajes.length, conversaciones: conversaciones.length },
  });

  return {
    contacto: contacto[0],
    identidades,
    conversaciones,
    mensajes,
    actividades,
    oportunidades,
    generadoEl: new Date().toISOString(),
  };
}

/**
 * Lo que sobrevive a una supresión, a propósito. Está acá y no en un
 * comentario suelto porque viaja en el resultado y en el audit: si alguien
 * pregunta qué quedó, la respuesta es esta lista y no la memoria de nadie.
 */
export const CONSERVADO = [
  'audit_log: es append-only y es la evidencia de esta misma supresión',
  'agent_executions: tokens, costo y latencia — la medición, sin el contenido',
  'payment_links: montos, estados y fechas, por obligación legal de guarda',
  'deals: el registro comercial del negocio (su título puede llevar el nombre)',
  'conversations: la fila vacía y archivada, para que el negocio sepa que hubo un trato',
] as const;

export interface ResultadoSupresion {
  contactId: string;
  mensajesBorrados: number;
  identidadesBorradas: number;
  adjuntosR2: string[];
  /** Ejecuciones de IA a las que se les vació el contenido (issue 235). */
  ejecucionesVaciadas: number;
  /** Tareas y notas de agenda borradas. */
  actividadesBorradas: number;
  /**
   * Lo que se conserva A PROPÓSITO y por qué: una supresión que no dice qué
   * dejó en pie no es evidencia de nada.
   */
  conservado: readonly string[];
}

/**
 * Supresión por solicitud. Irreversible a propósito: si quedara una copia
 * "por si acaso", no sería una supresión.
 *
 * Se corre DENTRO de la transacción de quien llama para que la auditoría y
 * el borrado caigan juntos: o pasó todo, o no pasó nada.
 */
export async function suprimirTitular(
  client: PoolClient,
  input: {
    tenantId: string;
    contactId: string;
    actor: string;
    motivo: string;
    requestId?: string;
  },
): Promise<ResultadoSupresion> {
  if (!input.motivo?.trim()) {
    throw new Error('La supresión necesita el motivo de la solicitud: es parte de la evidencia.');
  }
  const existe = await client.query(
    'SELECT id FROM contacts WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
    [input.tenantId, input.contactId],
  );
  if (existe.rowCount === 0) throw new Error('No encontramos a esa persona en este negocio.');

  const conversaciones = await client.query(
    'SELECT id FROM conversations WHERE tenant_id = $1 AND contact_id = $2',
    [input.tenantId, input.contactId],
  );
  const ids = conversaciones.rows.map((r) => r.id as string);

  // Las llaves de R2 ANTES de borrar los mensajes: después ya no se sabe
  // cuáles eran, y los adjuntos quedarían huérfanos para siempre.
  const adjuntosR2: string[] = [];
  if (ids.length > 0) {
    const adjuntos = await client.query(
      `SELECT jsonb_array_elements(attachments)->>'key' AS key FROM messages
        WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[])
          AND jsonb_array_length(attachments) > 0`,
      [input.tenantId, ids],
    );
    for (const fila of adjuntos.rows) if (fila.key) adjuntosR2.push(fila.key as string);
  }

  // Los ids de ejecución de IA ANTES de borrar las sugerencias: la sugerencia
  // es el único puente hacia `agent_executions`, y ahí está guardado el texto
  // de la conversación tal cual se le mandó al modelo (issue 235). Borrar los
  // mensajes y dejar esa copia no es una supresión.
  const ejecuciones: string[] = [];
  if (ids.length > 0) {
    const r = await client.query(
      `SELECT DISTINCT execution_id FROM suggestions
        WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[]) AND execution_id IS NOT NULL`,
      [input.tenantId, ids],
    );
    for (const fila of r.rows) if (fila.execution_id) ejecuciones.push(fila.execution_id as string);
  }

  let mensajesBorrados = 0;
  if (ids.length > 0) {
    const borrados = await client.query(
      'DELETE FROM messages WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[])',
      [input.tenantId, ids],
    );
    mensajesBorrados = borrados.rowCount ?? 0;
    for (const tabla of ['internal_notes', 'suggestions', 'response_samples']) {
      await client
        .query(`DELETE FROM ${tabla} WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[])`, [
          input.tenantId,
          ids,
        ])
        .catch(() => undefined);
    }
    // La conversación queda, vacía y marcada: el negocio necesita saber que
    // hubo un trato con alguien, aunque ya no sepa con quién.
    await client.query(
      `UPDATE conversations SET summary = NULL, archived_at = COALESCE(archived_at, now())
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [input.tenantId, ids],
    );
  }

  // El contenido de las ejecuciones de IA se vacía; la MEDICIÓN se conserva.
  // Tokens y costo alimentan la factura y el centro de IA: borrar la fila
  // entera falsearía cuentas que no son del titular.
  let ejecucionesVaciadas = 0;
  if (ejecuciones.length > 0) {
    const r = await client
      .query(
        `UPDATE agent_executions
            SET input = '{}'::jsonb, output = NULL, explanation = NULL
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [input.tenantId, ejecuciones],
      )
      .catch(() => ({ rowCount: 0 }));
    ejecucionesVaciadas = r.rowCount ?? 0;
  }

  // Las tareas y notas de agenda son texto libre SOBRE esa persona.
  const actividades = await client
    .query('DELETE FROM activities WHERE tenant_id = $1 AND contact_id = $2', [
      input.tenantId,
      input.contactId,
    ])
    .catch(() => ({ rowCount: 0 }));

  // De los cobros se vacía el concepto —lo escribe el negocio y ahí se cuela
  // el nombre—; montos, estados y fechas se conservan: son registros
  // financieros con obligación legal de guarda.
  await client
    .query(
      `UPDATE payment_links SET concept = NULL
        WHERE tenant_id = $1 AND (contact_id = $2 OR conversation_id = ANY($3::uuid[]))`,
      [input.tenantId, input.contactId, ids],
    )
    .catch(() => undefined);

  // Lo que viajó a terceros por webhook lleva el contenido dentro del
  // payload. La entrega en sí queda registrada; el contenido, no.
  await client
    .query(
      `UPDATE webhook_deliveries SET payload = '{}'::jsonb, response_body = NULL
        WHERE tenant_id = $1
          AND (payload::text LIKE '%' || $2::text || '%'
               OR ($3::uuid[] <> '{}'::uuid[] AND payload::text ~ ANY(SELECT unnest($3::uuid[])::text)))`,
      [input.tenantId, input.contactId, ids],
    )
    .catch(() => undefined);

  const identidades = await client.query(
    'DELETE FROM contact_identities WHERE tenant_id = $1 AND contact_id = $2',
    [input.tenantId, input.contactId],
  );

  // El contacto se despersonaliza. `custom` se vacía entero: ahí es donde el
  // negocio guarda lo que se le ocurre, y ahí es donde se esconde la PII.
  await client.query(
    `UPDATE contacts SET
       name = NULL, phone = NULL, email = NULL, rut = NULL,
       custom = '{}'::jsonb, opt_in_evidence = NULL,
       opted_out_at = COALESCE(opted_out_at, now()),
       updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.contactId],
  );

  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'titular.suprimido',
    resource: 'contact',
    resourceId: input.contactId,
    result: 'ok',
    requestId: input.requestId,
    metadata: {
      motivo: input.motivo,
      mensajesBorrados,
      identidadesBorradas: identidades.rowCount ?? 0,
      adjuntos: adjuntosR2.length,
      ejecucionesVaciadas,
      actividadesBorradas: actividades.rowCount ?? 0,
      conservado: CONSERVADO,
    },
  });

  return {
    contactId: input.contactId,
    mensajesBorrados,
    identidadesBorradas: identidades.rowCount ?? 0,
    adjuntosR2,
    ejecucionesVaciadas,
    actividadesBorradas: actividades.rowCount ?? 0,
    conservado: CONSERVADO,
  };
}
