import type { PoolClient } from 'pg';
import type { AlmacenObjetos } from '@iaxti/core';
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
// Y los archivos que mandó: los bytes viven en R2, no en Postgres, así que
// borrar la fila del mensaje no borra la foto. Eso hay que pedírselo al bucket
// explícitamente, y es parte de la supresión, no un pendiente para después.
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
  input: {
    tenantId: string;
    contactId: string;
    actor: string;
    requestId?: string;
    leerConversaciones: (client: PoolClient, input: { tenantId: string; contactId: string }) => Promise<{
      conversaciones: Array<Record<string, unknown>>;
      mensajes: Array<Record<string, unknown>>;
    }>;
  },
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
  const { conversaciones, mensajes } = await input.leerConversaciones(client, input);
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
  /**
   * Llaves de R2 que se borraron DE VERDAD. Antes traía las llaves
   * ENCONTRADAS —nadie las borraba— y la app las mostraba como "N adjuntos"
   * en la lista de lo que se borró. Si acá viene una llave, ese objeto ya no
   * está en el bucket.
   *
   * El nombre se mantiene a propósito: lo lee el panel de derechos del
   * titular en la web. Renombrarlo a `adjuntosBorrados`, que es lo que es,
   * pide el mismo PR que ese componente.
   */
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
 * Puertos conectados por la API con los contract.ts de cada dueño. Inyectarlos
 * evita el ciclo CRM → conversations → CRM. Son obligatorios: apagar una
 * función comercial no elimina sus datos ni suspende el derecho del titular.
 */
export interface SupresionEnModulos {
  datos: (client: PoolClient, input: { tenantId: string; contactId: string }) => Promise<{
    conversationIds: string[];
    adjuntosR2: string[];
  }>;
  agents: (client: PoolClient, input: ParteDeSupresion) => Promise<{ ejecucionesVaciadas: number }>;
  conversations: (client: PoolClient, input: ParteDeSupresion) => Promise<{ mensajesBorrados: number }>;
  integrations: (client: PoolClient, input: ParteDeSupresion) => Promise<void>;
  payments: (client: PoolClient, input: ParteDeSupresion) => Promise<void>;
  analytics: (client: PoolClient, input: ParteDeSupresion) => Promise<void>;
}

interface ParteDeSupresion {
  tenantId: string;
  contactId: string;
  conversationIds: string[];
  actor: string;
  requestId?: string;
}

/**
 * Supresión por solicitud. Irreversible a propósito: si quedara una copia
 * "por si acaso", no sería una supresión.
 *
 * Se corre DENTRO de la transacción de quien llama para que la auditoría y
 * el borrado caigan juntos: o pasó todo, o no pasó nada.
 *
 * Los adjuntos del bucket se borran ACÁ, antes de escribir la auditoría, y si
 * alguno no se puede borrar la función lanza y la transacción se deshace
 * completa. Es a propósito: la alternativa es contestarle a un titular que sus
 * datos se borraron mientras las fotos y los PDF que mandó siguen bajables con
 * una URL firmada. Deshacer y pedir reintento es incómodo; declarar una
 * supresión que no ocurrió es una declaración falsa con consecuencia legal.
 * El borrado en R2 es idempotente (un 404 cuenta como borrado), así que
 * reintentar una supresión que quedó a medio camino es seguro.
 */
export async function suprimirTitular(
  client: PoolClient,
  input: {
    tenantId: string;
    contactId: string;
    actor: string;
    motivo: string;
    requestId?: string;
    /**
     * El bucket. OBLIGATORIO y no ambiental: `almacenR2()` lee las `R2_*` al
     * llamarse, y los tests de otros archivos las escriben a nivel de proceso
     * (vitest comparte `process.env` entre archivos del mismo hilo). Una
     * supresión legal que cambia de comportamiento según qué test corrió al lado
     * no es una supresión que se pueda declarar cumplida.
     */
    almacen: AlmacenObjetos | null;
    modulos: SupresionEnModulos;
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

  const { conversationIds, adjuntosR2: adjuntosPorBorrar } = await input.modulos.datos(client, input);
  const parte = {
    tenantId: input.tenantId,
    contactId: input.contactId,
    conversationIds,
    actor: input.actor,
    requestId: input.requestId,
  };
  // En serie, con el MISMO cliente. Agents usa suggestions antes de borrarlas;
  // cualquier fallo (también de auditoría) se propaga y revierte todo.
  const { ejecucionesVaciadas } = await input.modulos.agents(client, parte);
  const { mensajesBorrados } = await input.modulos.conversations(client, parte);
  await input.modulos.integrations(client, parte);
  await input.modulos.payments(client, parte);
  await input.modulos.analytics(client, parte);

  // Las tareas y notas de agenda son texto libre SOBRE esa persona, propiedad de CRM.
  const actividades = await client.query(
    'DELETE FROM activities WHERE tenant_id = $1 AND contact_id = $2',
    [input.tenantId, input.contactId],
  );

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

  // Los archivos del bucket, ahora sí. Va acá, después de la base y ANTES de
  // la auditoría, porque la auditoría es la declaración de lo que pasó: si se
  // escribiera antes, diría "adjuntos borrados" sin saber si se borraron.
  const adjuntosBorrados: string[] = [];
  if (adjuntosPorBorrar.length > 0) {
    const almacen = input.almacen;
    if (!almacen) {
      throw new Error(
        'Esta persona envió archivos y este ambiente no tiene el almacenamiento configurado ' +
          '(revisa R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY y R2_BUCKET_ADJUNTOS). ' +
          'Deshicimos la supresión para no darla por hecha: configúralo y vuelve a pedirla.',
      );
    }
    const { borradas, fallidas } = await almacen.borrar(adjuntosPorBorrar);
    adjuntosBorrados.push(...borradas);
    if (fallidas.length > 0) {
      throw new Error(
        `No pudimos borrar ${fallidas.length} de ${adjuntosPorBorrar.length} archivos del ` +
          'almacenamiento, así que deshicimos la supresión completa: no podemos declarar ' +
          'borrado algo que sigue ahí. Vuelve a pedirla en unos minutos; reintentar es seguro.',
      );
    }
  }

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
      adjuntos: adjuntosBorrados.length,
      ejecucionesVaciadas,
      actividadesBorradas: actividades.rowCount ?? 0,
      conservado: CONSERVADO,
    },
  });

  return {
    contactId: input.contactId,
    mensajesBorrados,
    identidadesBorradas: identidades.rowCount ?? 0,
    adjuntosR2: adjuntosBorrados,
    ejecucionesVaciadas,
    actividadesBorradas: actividades.rowCount ?? 0,
    conservado: CONSERVADO,
  };
}
