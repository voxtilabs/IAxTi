import type { PoolClient } from 'pg';
import { writeAudit, type ActorKind } from '@iaxti/module-audit';
import { telefonosDelEquipo, quienesSon, type Quien } from '@iaxti/module-identity';
import { normalizePhone } from '@iaxti/module-crm';
import { getTenantSettings } from '@iaxti/module-organizations';
import { bandejaSettings, enSilencio } from '../domain/horario';
import { isWithinWindow } from '../domain/state';
import type { ConversationState, DeliveryStatus } from '../domain/state';
import { sendMessage } from './conversations';

/**
 * Escribirle de una vez a todos los que conversaron (#1247).
 *
 * Al cerrar el stand de una feria hace falta mandarles lo mismo a las personas
 * que escribieron en el día: «gracias, el bot ya no te molesta más, acá están
 * nuestras redes». La ventana de 24 h es lo que hace posible responderles
 * libre —esas personas escribieron— y fuera de ella hace falta plantilla
 * aprobada, que es otra pantalla.
 *
 * ## Lo que este caso de uso NO vuelve a imponer
 *
 * La baja (`opted_out_at`), el consentimiento, el estado del negocio, el cupo
 * del día con su reserva para lo que manda una persona y el horario de
 * silencio los aplica el worker de la cola `outbound` MENSAJE POR MENSAJE
 * (#1248): cada mensaje sale con `delivery: 'business'`, que el consumidor del
 * outbox traduce a `initiatedByBusiness: true` y SIN `transaccional`.
 * Reimplementar esas reglas acá sería la segunda implementación de la misma
 * regla, que es el defecto que #639 le sacó a la ventana. Lo que acá sí hay
 * que saber es lo que se puede DECIR antes de mandar: quién queda fuera y por
 * qué, y si el envío caería en silencio (se difiere, no se descarta).
 *
 * ## Dos pasos, y el primero congela
 *
 * La previsualización persiste su conjunto de destinatarios: el envío manda
 * EXACTAMENTE a esos, recalculando la elegibilidad de cada uno al vuelo —si
 * alguien se dio de baja entre la previa y el envío, no entra y queda escrito
 * por qué. Un WhatsApp no se puede deshacer; la pantalla que lo manda muestra
 * el texto y el conteo antes de dejar apretar el botón.
 */

/** Conflicto de negocio del envío; los de infraestructura siguen siendo 500. */
export class DifusionError extends Error {}

/** Por qué alguien que conversó queda fuera de la difusión. */
export type MotivoDeExclusion = 'es del equipo' | 'se dio de baja' | 'ventana cerrada';

export interface FiltroDeDifusion {
  /** Estado de la conversación; sin filtro son las que la bandeja muestra. */
  estado?: ConversationState;
  /** Una etiqueta del contacto (crm): «los que quedaron con la etiqueta feria». */
  etiquetaId?: string;
}

export interface PreviaDeDifusion {
  id: string;
  texto: string;
  /** A cuántos les llegaría. */
  total: number;
  /** Unas pocas personas, para reconocer al grupo antes de mandar. */
  muestra: Array<{ conversationId: string; nombre: string | null; telefono: string }>;
  /** Quienes conversaron pero quedan fuera, agrupados por motivo. */
  fuera: Array<{ motivo: MotivoDeExclusion; n: number }>;
  /** El tope nuestro dejó gente afuera: el aviso dice cómo estrechar el filtro. */
  truncado: boolean;
  /** Estamos en horario de silencio: el envío se difiere al siguiente horario. */
  enSilencio: boolean;
}

/**
 * Cuántos destinatarios como máximo por difusión.
 *
 * El envío crea un mensaje por destinatario dentro del request, con su evento
 * y su auditoría (unas seis consultas por persona): el tope mantiene esa
 * cuenta acotada igual que el segmento de una campaña tiene el suyo. No es el
 * tope del canal — ese lo aplica el worker, difiriendo lo que no alcanza.
 */
export const TOPE_DIFUSION = 500;

/** La muestra de la previa: cuántas personas alcanza a reconocer quien mira. */
const TAMANO_DE_MUESTRA = 5;

/**
 * El teléfono con el medio tapado, para la previsualización.
 *
 * La previa la puede abrir quien atiende, antes de decidir nada: sirve para
 * reconocer que el grupo es el correcto, no para repartir la lista de
 * teléfonos de hoy.
 */
export function enmascararTelefono(phone: string): string {
  if (phone.length <= 6) return phone;
  return `${phone.slice(0, 6)}···${phone.slice(-2)}`;
}

interface Candidato {
  conversationId: string;
  contactId: string;
  nombre: string | null;
  telefono: string | null;
  optedOutAt: Date | null;
  lastInboundAt: Date | null;
}

/**
 * Las conversaciones de WhatsApp que la bandeja mostraría, con su contacto.
 *
 * El mismo recorte que `listInbox` sin filtros: sin archivadas ni resueltas.
 * El resto —ventana, baja, equipo— se clasifica aparte, porque quedarse fuera
 * por eso es algo que la previa tiene que PODER DECIR con su motivo.
 */
async function candidatos(
  client: PoolClient,
  input: { tenantId: string; filtro: FiltroDeDifusion },
): Promise<Candidato[]> {
  const params: unknown[] = [input.tenantId];
  let where = `c.tenant_id = $1 AND c.channel = 'whatsapp'
               AND c.archived_at IS NULL AND c.state <> 'resolved'`;
  if (input.filtro.estado) {
    params.push(input.filtro.estado);
    where += ` AND c.state = $${params.length}`;
  }
  if (input.filtro.etiquetaId) {
    params.push(input.filtro.etiquetaId);
    where += ` AND EXISTS (
      SELECT 1 FROM contact_tags ct
       WHERE ct.tenant_id = c.tenant_id AND ct.contact_id = c.contact_id
         AND ct.tag_id = $${params.length})`;
  }
  const r = await client.query(
    `SELECT c.id AS conversation_id, k.id AS contact_id, k.name AS nombre,
            k.phone AS telefono, k.opted_out_at, c.last_inbound_at
       FROM conversations c
       JOIN contacts k ON k.id = c.contact_id
      WHERE ${where}
      ORDER BY c.last_inbound_at DESC NULLS LAST, c.id`,
    params,
  );
  return r.rows.map((row) => ({
    conversationId: row.conversation_id as string,
    contactId: row.contact_id as string,
    nombre: (row.nombre as string) ?? null,
    telefono: (row.telefono as string) ?? null,
    optedOutAt: (row.opted_out_at as Date) ?? null,
    lastInboundAt: (row.last_inbound_at as Date) ?? null,
  }));
}

/**
 * Los teléfonos del equipo, normalizados a E.164 como los de `contacts`.
 *
 * Uno que no se puede normalizar se descarta en silencio: el teléfono del
 * perfil lo escribió una persona sobre sí misma, y dejar fuera a un cliente
 * porque el de un colega quedó a medias sería castigar al destinatario por un
 * dato ajeno.
 */
async function telefonosNormalizadosDelEquipo(
  client: PoolClient,
  tenantId: string,
): Promise<Set<string>> {
  const equipo = new Set<string>();
  for (const crudo of await telefonosDelEquipo(client, tenantId)) {
    try {
      equipo.add(normalizePhone(crudo));
    } catch {
      /* un perfil con el teléfono a medias no identifica a nadie */
    }
  }
  return equipo;
}

/**
 * Por qué ESTE candidato no debería recibir la difusión.
 *
 * El orden es el orden en que se lee: primero que no es un cliente (es del
 * equipo), luego que pidió no recibir, y la ventana al final — que es el
 * estado normal de una conversación vieja y no un dato sobre la persona.
 */
function motivoDeExclusion(
  candidato: Candidato,
  equipo: ReadonlySet<string>,
  ahora: Date,
): MotivoDeExclusion | null {
  if (candidato.telefono && equipo.has(candidato.telefono)) return 'es del equipo';
  if (candidato.optedOutAt) return 'se dio de baja';
  // La MISMA función del envío normal (#639): la regla de la ventana vive una
  // sola vez, y reescribirla acá es cómo se separa de la del canal.
  if (!isWithinWindow('whatsapp', candidato.lastInboundAt, ahora)) return 'ventana cerrada';
  return null;
}

/** ¿El silencio del negocio está activo ahora? Se avisa; se difiere, no se corta. */
async function enSilencioAhora(client: PoolClient, tenantId: string, ahora: Date): Promise<boolean> {
  const settings = bandejaSettings(await getTenantSettings(client, tenantId));
  return enSilencio(settings.silencio, ahora);
}

/** La previsualización: cuenta, muestra, quienes quedan fuera y el silencio. No manda nada. */
export async function previsualizarDifusion(
  client: PoolClient,
  input: {
    tenantId: string;
    texto: string;
    filtro: FiltroDeDifusion;
    actor: string;
    actorKind: ActorKind;
    requestId?: string;
    /** El reloj, inyectado para que la prueba no mida el de la máquina. */
    ahora?: Date;
  },
): Promise<PreviaDeDifusion> {
  const ahora = input.ahora ?? new Date();
  const [equipo, todos, silencio] = await Promise.all([
    telefonosNormalizadosDelEquipo(client, input.tenantId),
    candidatos(client, { tenantId: input.tenantId, filtro: input.filtro }),
    enSilencioAhora(client, input.tenantId, ahora),
  ]);

  const dentro: Candidato[] = [];
  const fuera = new Map<MotivoDeExclusion, number>();
  for (const candidato of todos) {
    const motivo = motivoDeExclusion(candidato, equipo, ahora);
    if (motivo === null) dentro.push(candidato);
    else fuera.set(motivo, (fuera.get(motivo) ?? 0) + 1);
  }
  const truncado = dentro.length > TOPE_DIFUSION;
  const destinatarios = truncado ? dentro.slice(0, TOPE_DIFUSION) : dentro;

  const d = await client.query(
    `INSERT INTO difusiones (tenant_id, texto, filtro, estado, previa, created_by)
     VALUES ($1, $2, $3::jsonb, 'previa', $4::jsonb, $5) RETURNING id`,
    [
      input.tenantId,
      input.texto,
      JSON.stringify(input.filtro),
      JSON.stringify({
        fuera: [...fuera].map(([motivo, n]) => ({ motivo, n })),
        truncado,
        total: destinatarios.length,
      }),
      input.actor,
    ],
  );
  const id = d.rows[0].id as string;
  if (destinatarios.length > 0) {
    await client.query(
      `INSERT INTO difusion_destinatarios (tenant_id, difusion_id, conversation_id, contact_id)
       SELECT $1, $2, c.conversation_id, c.contact_id
         FROM unnest($3::uuid[], $4::uuid[]) AS c(conversation_id, contact_id)`,
      [
        input.tenantId,
        id,
        destinatarios.map((c) => c.conversationId),
        destinatarios.map((c) => c.contactId),
      ],
    );
  }
  await writeAudit(client, {
    tenantId: input.tenantId, actor: input.actor, actorKind: input.actorKind,
    action: 'conversation.difusion_previewed', resource: 'difusion', resourceId: id,
    requestId: input.requestId, result: 'success',
    metadata: { total: destinatarios.length, truncado, filtro: input.filtro },
  });
  return {
    id,
    texto: input.texto,
    total: destinatarios.length,
    muestra: destinatarios.slice(0, TAMANO_DE_MUESTRA).map((c) => ({
      conversationId: c.conversationId,
      nombre: c.nombre,
      telefono: enmascararTelefono(c.telefono ?? ''),
    })),
    fuera: [...fuera].map(([motivo, n]) => ({ motivo, n })),
    truncado,
    enSilencio: silencio,
  };
}

/** El envío: un mensaje por destinatario de la previa que SIGA correspondiendo. */
export async function enviarDifusion(
  client: PoolClient,
  input: {
    tenantId: string;
    difusionId: string;
    actor: string;
    actorKind: ActorKind;
    requestId?: string;
    ahora?: Date;
  },
): Promise<{ id: string; total: number; fuera: Array<{ motivo: MotivoDeExclusion; n: number }> }> {
  const ahora = input.ahora ?? new Date();
  const d = await client.query(
    `SELECT id, texto, estado FROM difusiones
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.difusionId],
  );
  if (d.rowCount === 0) {
    throw new DifusionError('No encontramos esa previsualización. Vuelve a armar el envío.');
  }
  if (d.rows[0].estado !== 'previa') {
    throw new DifusionError('Este envío ya salió. Arma uno nuevo desde la bandeja.');
  }

  const destinatarios = await client.query(
    `SELECT dt.conversation_id, dt.contact_id, k.name AS nombre, k.phone AS telefono,
            k.opted_out_at, c.last_inbound_at
       FROM difusion_destinatarios dt
       JOIN conversations c ON c.id = dt.conversation_id
       JOIN contacts k ON k.id = dt.contact_id
      WHERE dt.tenant_id = $1 AND dt.difusion_id = $2
      ORDER BY c.last_inbound_at DESC NULLS LAST, c.id`,
    [input.tenantId, input.difusionId],
  );
  if (destinatarios.rowCount === 0) {
    throw new DifusionError(
      'La previsualización no tiene destinatarios. Revisa el filtro antes de enviar.',
    );
  }

  const equipo = await telefonosNormalizadosDelEquipo(client, input.tenantId);
  const texto = d.rows[0].texto as string;
  const fuera = new Map<MotivoDeExclusion, number>();
  let total = 0;
  for (const row of destinatarios.rows) {
    const candidato: Candidato = {
      conversationId: row.conversation_id,
      contactId: row.contact_id,
      nombre: (row.nombre as string) ?? null,
      telefono: (row.telefono as string) ?? null,
      optedOutAt: (row.opted_out_at as Date) ?? null,
      lastInboundAt: (row.last_inbound_at as Date) ?? null,
    };
    // El recálculo: la previa congeló a quiénes; esto revisa si SIGUEN siendo
    // destinatarios. Quien se dio de baja entremedio no recibe, y queda escrito.
    const motivo = motivoDeExclusion(candidato, equipo, ahora);
    if (motivo !== null) {
      fuera.set(motivo, (fuera.get(motivo) ?? 0) + 1);
      await client.query(
        `UPDATE difusion_destinatarios SET excluido = $3
          WHERE tenant_id = $1 AND difusion_id = $2 AND conversation_id = $4`,
        [input.tenantId, input.difusionId, motivo, candidato.conversationId],
      );
      continue;
    }
    // El mismo camino del responder (`sendMessage` con entrega `business`):
    // crea el mensaje `queued` y su pedido durable, que el worker despacha
    // con initiatedByBusiness — silencio, cupo y consentimiento incluidos.
    const message = await sendMessage(client, {
      tenantId: input.tenantId,
      conversationId: candidato.conversationId,
      authorKind: 'user',
      authorId: input.actor,
      type: 'texto',
      body: texto,
      delivery: 'business',
      actorKind: input.actorKind,
      requestId: input.requestId,
      meta: { difusion: { id: input.difusionId } },
    });
    total += 1;
    await client.query(
      `UPDATE difusion_destinatarios SET message_id = $3, intentos = 1
        WHERE tenant_id = $1 AND difusion_id = $2 AND conversation_id = $4`,
      [input.tenantId, input.difusionId, message.id, candidato.conversationId],
    );
  }

  await client.query(
    `UPDATE difusiones SET estado = 'enviada', total = $3, enviada_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.difusionId, total],
  );
  await writeAudit(client, {
    tenantId: input.tenantId, actor: input.actor, actorKind: input.actorKind,
    action: 'conversation.difusion_sent', resource: 'difusion', resourceId: input.difusionId,
    requestId: input.requestId, result: 'success',
    metadata: { total, fuera: [...fuera].map(([motivo, n]) => ({ motivo, n })) },
  });
  return { id: input.difusionId, total, fuera: [...fuera].map(([motivo, n]) => ({ motivo, n })) };
}

export interface DestinatarioDeDifusion {
  conversationId: string;
  nombre: string | null;
  telefono: string | null;
  messageId: string | null;
  deliveryStatus: DeliveryStatus | null;
  /** Por qué no llegó, en la voz en que el canal lo guarda (#645). */
  error: string | null;
  /** Por qué quedó fuera del envío, cuando el recálculo lo sacó. */
  excluido: string | null;
  intentos: number;
}

/** El resultado por destinatario: qué pasó con cada mensaje. */
export async function resultadoDifusion(
  client: PoolClient,
  input: { tenantId: string; difusionId: string },
): Promise<{
  id: string;
  texto: string;
  estado: 'previa' | 'enviada';
  total: number | null;
  createdAt: Date;
  enviadaAt: Date | null;
  /** Quién apretó enviar (#697): «¿quién mandó esto a 31 personas?» es la primera pregunta cuando algo sale mal. */
  creadaPor: Quien | null;
  destinatarios: DestinatarioDeDifusion[];
}> {
  const d = await client.query(
    `SELECT id, texto, estado, total, created_at, enviada_at, created_by FROM difusiones
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.difusionId],
  );
  if (d.rowCount === 0) {
    throw new DifusionError('No encontramos ese envío.');
  }
  const row = d.rows[0];
  const quien = (await quienesSon(client, input.tenantId, [row.created_by as string])).get(
    row.created_by as string,
  ) ?? null;
  const r = await client.query(
    `SELECT dt.conversation_id, k.name AS nombre, k.phone AS telefono,
            dt.message_id, m.delivery_status, m.meta, dt.excluido, dt.intentos
       FROM difusion_destinatarios dt
       JOIN contacts k ON k.id = dt.contact_id
       JOIN conversations c ON c.id = dt.conversation_id
       LEFT JOIN messages m ON m.id = dt.message_id
      WHERE dt.tenant_id = $1 AND dt.difusion_id = $2
      ORDER BY c.last_inbound_at DESC NULLS LAST, c.id`,
    [input.tenantId, input.difusionId],
  );
  return {
    id: row.id,
    texto: row.texto,
    estado: row.estado,
    total: row.total === null ? null : Number(row.total),
    createdAt: row.created_at,
    enviadaAt: (row.enviada_at as Date) ?? null,
    creadaPor: quien,
    destinatarios: r.rows.map((dRow) => ({
      conversationId: dRow.conversation_id,
      nombre: (dRow.nombre as string) ?? null,
      telefono: (dRow.telefono as string) ?? null,
      messageId: (dRow.message_id as string) ?? null,
      deliveryStatus: (dRow.delivery_status as DeliveryStatus | null) ?? null,
      error: ((dRow.meta as Record<string, unknown> | null)?.error as string | undefined) ?? null,
      excluido: (dRow.excluido as string) ?? null,
      intentos: Number(dRow.intentos),
    })),
  };
}

/**
 * Reintentar SOLO los fallidos.
 *
 * La entrega que terminó en `failed` no retrocede (la regla de `messages`): el
 * reintento crea OTRO mensaje a esa persona, por el mismo camino de siempre.
 * A quien recibió no se le vuelve a mandar: su mensaje no está `failed` y esta
 * función no lo toca.
 */
export async function reintentarDifusion(
  client: PoolClient,
  input: {
    tenantId: string;
    difusionId: string;
    actor: string;
    actorKind: ActorKind;
    requestId?: string;
    ahora?: Date;
  },
): Promise<{ reintentados: number; fuera: Array<{ motivo: MotivoDeExclusion; n: number }> }> {
  const ahora = input.ahora ?? new Date();
  const d = await client.query(
    `SELECT id, texto, estado FROM difusiones
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.difusionId],
  );
  if (d.rowCount === 0) throw new DifusionError('No encontramos ese envío.');
  if (d.rows[0].estado !== 'enviada') {
    throw new DifusionError('Este envío todavía no sale; reintenta cuando haya fallidos.');
  }
  const fallidos = await client.query(
    `SELECT dt.conversation_id, k.opted_out_at, k.phone AS telefono, c.last_inbound_at
       FROM difusion_destinatarios dt
       JOIN conversations c ON c.id = dt.conversation_id
       JOIN contacts k ON k.id = dt.contact_id
       JOIN messages m ON m.id = dt.message_id
      WHERE dt.tenant_id = $1 AND dt.difusion_id = $2
        AND dt.excluido IS NULL AND m.delivery_status = 'failed'
      ORDER BY c.last_inbound_at DESC NULLS LAST, c.id`,
    [input.tenantId, input.difusionId],
  );
  const equipo = await telefonosNormalizadosDelEquipo(client, input.tenantId);
  const texto = d.rows[0].texto as string;
  const fuera = new Map<MotivoDeExclusion, number>();
  let reintentados = 0;
  for (const row of fallidos.rows) {
    const candidato: Candidato = {
      conversationId: row.conversation_id,
      contactId: '',
      nombre: null,
      telefono: (row.telefono as string) ?? null,
      optedOutAt: (row.opted_out_at as Date) ?? null,
      lastInboundAt: (row.last_inbound_at as Date) ?? null,
    };
    // Mismo recálculo que el envío: reintentarle a quien acaba de pedir que no
    // le escribamos sería usar el reintento para saltarse la baja.
    const motivo = motivoDeExclusion(candidato, equipo, ahora);
    if (motivo !== null) {
      fuera.set(motivo, (fuera.get(motivo) ?? 0) + 1);
      await client.query(
        `UPDATE difusion_destinatarios SET excluido = $3
          WHERE tenant_id = $1 AND difusion_id = $2 AND conversation_id = $4`,
        [input.tenantId, input.difusionId, motivo, candidato.conversationId],
      );
      continue;
    }
    const message = await sendMessage(client, {
      tenantId: input.tenantId,
      conversationId: candidato.conversationId,
      authorKind: 'user',
      authorId: input.actor,
      type: 'texto',
      body: texto,
      delivery: 'business',
      actorKind: input.actorKind,
      requestId: input.requestId,
      meta: { difusion: { id: input.difusionId, reintento: true } },
    });
    reintentados += 1;
    await client.query(
      `UPDATE difusion_destinatarios SET message_id = $3, intentos = intentos + 1
        WHERE tenant_id = $1 AND difusion_id = $2 AND conversation_id = $4`,
      [input.tenantId, input.difusionId, message.id, candidato.conversationId],
    );
  }
  await writeAudit(client, {
    tenantId: input.tenantId, actor: input.actor, actorKind: input.actorKind,
    action: 'conversation.difusion_retried', resource: 'difusion', resourceId: input.difusionId,
    requestId: input.requestId, result: 'success', metadata: { reintentados },
  });
  return { reintentados, fuera: [...fuera].map(([motivo, n]) => ({ motivo, n })) };
}
