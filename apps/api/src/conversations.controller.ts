import {
  BadRequestException,
  Controller,
  ForbiddenException,
  ConflictException,
  UnprocessableEntityException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import { z } from 'zod';
import {
  assignConversation,
  changeConversationState,
  getConversation,
  getConversationDetail,
  isWithinWindow,
  listInbox,
  listMessages,
  retentionCutoff,
  retryOutboundDelivery,
  OutboundRetryError,
  sendMessage,
  updateDeliveryStatus,
} from '@iaxti/module-conversations';
import type {
  Channel,
  ConversationState,
  InboxFilters,
  MessageType,
} from '@iaxti/module-conversations';
import {
  activeAgent,
  conversationAnalysis,
  effectiveMode,
  feedbackSuggestion,
  pendingSuggestion,
  porQueNoHaySugerencia,
  resolveSuggestion,
  setConversationMode,
} from '@iaxti/module-agents';
import { RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo, textoRequerido } from './validar';
import type { Actor, WithUser } from './authz/authz.guard';
import { actorCan } from './authz/can';
import { apiPool } from './db';

function pool() {
  const p = apiPool();
  if (!p) {
    throw new ServiceUnavailableException({
      code: 'DB_NOT_CONFIGURED',
      message: 'El servidor aún no tiene base de datos configurada. Intenta más tarde.',
    });
  }
  return p;
}


function actorOf(request: WithUser): Actor {
  // El guard de @RequirePermission siempre lo adjunta.
  return request.actor as Actor;
}

interface EntregaInput {
  actor: Actor;
  conversationId: string;
  conversation: Awaited<ReturnType<typeof getConversation>>;
  texto: string;
  type: MessageType;
  /** Lo que se subió a R2 antes de responder (#458): llave, nombre y tipo. */
  adjuntos?: Array<{ key: string; filename?: string; contentType?: string }>;
  requestId?: string;
}

/** El flujo de responder (reply y "Enviar sugerencia" comparten camino). */
async function entregarRespuesta(
  c: Parameters<typeof sendMessage>[0],
  input: EntregaInput,
) {
  const { actor, conversation, conversationId } = input;
  // Responder desde la cola es tomarla: dueño + new → open (SPEC §11).
  if (conversation.ownerId === null) {
    await assignConversation(c, {
      tenantId: actor.tenantId,
      conversationId,
      toOwnerId: actor.userId,
      reason: 'respondió desde la bandeja',
      actor: actor.userId,
      requestId: input.requestId,
    });
  }
  const message = await sendMessage(c, {
    tenantId: actor.tenantId,
    conversationId,
    authorKind: 'user',
    authorId: actor.userId,
    type: input.type,
    body: input.texto,
    ...(input.adjuntos?.length ? { attachments: input.adjuntos } : {}),
    requestId: input.requestId,
    delivery: 'reply',
    actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
  });
  // Simulador y webchat entregan al instante (el widget sondea, #46).
  // WhatsApp va por la cola outbound con rate limit y reintentos (#43).
  if (conversation.channel === 'simulador' || conversation.channel === 'webchat') {
    return updateDeliveryStatus(c, {
      tenantId: actor.tenantId,
      messageId: message.id,
      status: 'sent',
      requestId: input.requestId,
    });
  }
  return message;
}

export function notFound(): never {
  throw new NotFoundException({
    code: 'CONVERSATION_NOT_FOUND',
    message: 'No encontramos esa conversación. Puede que se haya archivado.',
  });
}

/**
 * Los esquemas de entrada (#524), arriba y al lado de sus rutas.
 *
 * El mensaje va ESCRITO en el esquema porque lo lee quien está atendiendo a un
 * cliente con el chat abierto, no quien programa: «Required» no le sirve de
 * nada. Y al esquema van solo los VALIDATION_ERROR — un error con código
 * propio (ADJUNTO_INVALIDO, OUTSIDE_WINDOW, INVALID_TRANSITION) se queda donde
 * está, porque zod da un solo código por esquema y cambiarlo movería el
 * contrato de la API.
 */

/** Responder: el texto, el adjunto, o los dos (#458). */
const Respuesta = z.object({
  // Ni el texto ni el adjunto son obligatorios por separado —una foto sola es
  // un mensaje completo—, así que el «manda algo» se queda como `if` abajo.
  body: z.string().optional(),
  type: z.string().optional(),
  // `key` queda OPCIONAL a propósito: un adjunto sin llave lo descarta el
  // filtro de la ruta y sale como ADJUNTO_INVALIDO, que es su código de hoy.
  // Exigirlo acá lo convertiría en VALIDATION_ERROR.
  adjuntos: z
    .array(
      z.object({
        key: z.string().optional(),
        filename: z.string().optional(),
        contentType: z.string().optional(),
      }),
    )
    .optional(),
});

const Asignacion = z.object({
  toOwnerId: textoRequerido('Indica a quién se asigna la conversación.'),
  reason: z.string().optional(),
});

const NuevoEstado = z.object({
  // Texto y no `z.enum`: el estado que existe pero no se alcanza desde el
  // actual lo rechaza el caso de uso con INVALID_TRANSITION y su motivo (lo
  // afirma la prueba de la bandeja). Un enum acá lo volvería VALIDATION_ERROR.
  state: textoRequerido('Indica el estado nuevo.'),
  snoozedUntil: z.string().optional(),
});

const Calificacion = z.object({
  feedback: z.enum(['up', 'down'], { error: 'El feedback es up o down.' }),
  reason: z.string().optional(),
});

const ModoDelAgente = z.object({
  mode: z.enum(['assist', 'autonomous', 'off'], {
    error: 'El modo es assist, autonomous u off.',
  }),
});

/**
 * La bandeja (SPEC §11, #37). La verificación de dueño que exige ADR-0008
 * vive aquí, en el caso de uso: sin `conversations.read_all` se ven las
 * propias y las sin dueño (para tomar de la cola), nunca las de un colega.
 */
@ApiTags('conversations')
@Controller('conversations')
@RequireModule('conversations')
export class ConversationsController {
  @Get()
  @RequirePermission('conversations.read')
  @ApiOperation({ summary: 'Bandeja: lista con filtros, vistas y cursor' })
  async list(
    @Req() request: WithUser,
    @Query('state') state?: string,
    @Query('channel') channel?: string,
    @Query('contactId') contactId?: string,
    @Query('view') view?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const actor = actorOf(request);
    const filters: InboxFilters = {
      state: state as ConversationState | undefined,
      channel: channel as Channel | undefined,
      contactId,
      view: view === 'sin_responder' ? 'sin_responder' : undefined,
      cursor,
      limit: limit ? Number(limit) : undefined,
    };
    if (view === 'mi_cola') filters.ownerId = actor.userId;
    else if (!actorCan(actor, 'conversations.read_all')) filters.ownerIdOrUnassigned = actor.userId;

    return withTenant(pool(), actor.tenantId, async (c) => {
      const res = await listInbox(c, actor.tenantId, filters);
      // La ficha del contacto muestra el corte de retención (#77): el
      // historial anterior a esa fecha ya no existe, por el plan.
      if (contactId) {
        const corte = await retentionCutoff(c, actor.tenantId);
        return {
          ...res,
          retention: corte.cutoff
            ? { cutoff: corte.cutoff.toISOString().slice(0, 10), months: corte.months }
            : null,
        };
      }
      return res;
    });
  }

  @Get(':id')
  @RequirePermission('conversations.read')
  @ApiOperation({ summary: 'Conversación con la ficha mínima del contacto' })
  async detail(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    const detail = await withTenant(pool(), actor.tenantId, (c) =>
      getConversationDetail(c, actor.tenantId, id),
    ).catch(notFound);
    if (
      !actorCan(actor, 'conversations.read_all') &&
      detail.ownerId !== null &&
      detail.ownerId !== actor.userId
    ) {
      notFound(); // no filtramos "existe pero no es tuya": misma respuesta
    }
    return detail;
  }

  @Get(':id/messages')
  @RequirePermission('conversations.read')
  @ApiOperation({ summary: 'Mensajes de la conversación, más nuevos primero' })
  async messages(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const conversation = await getConversation(c, actor.tenantId, id).catch(notFound);
      if (
        !actorCan(actor, 'conversations.read_all') &&
        conversation.ownerId !== null &&
        conversation.ownerId !== actor.userId
      ) {
        notFound();
      }
      return listMessages(c, actor.tenantId, id, limit ? Number(limit) : 50);
    });
  }

  @Post(':id/messages')
  @RequirePermission('conversations.reply')
  @ApiOperation({ summary: 'Responde en la conversación (la toma si estaba en cola)' })
  async reply(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(Respuesta) body: z.infer<typeof Respuesta>,
  ) {
    const actor = actorOf(request);
    // El prefijo NO se valida en el esquema: depende del tenant de quien pide,
    // que el esquema no conoce. Con adjunto, el texto es opcional: una foto
    // sola es un mensaje completo. Sin adjunto y sin texto no hay nada que
    // mandar (#458).
    const adjuntos = (body.adjuntos ?? [])
      .filter((a): a is { key: string; filename?: string; contentType?: string } =>
        typeof a.key === 'string' && a.key.startsWith(`${actor.tenantId}/`))
      .slice(0, 1);
    // Este VALIDATION_ERROR se queda acá: no es «falta un campo» sino «entre
    // el texto y el adjunto no vino ninguno», y los adjuntos que cuentan son
    // los que pasaron el filtro del tenant de arriba.
    if (!body.body?.trim() && adjuntos.length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Escribe el mensaje o adjunta un archivo antes de enviarlo.',
        details: [{ field: 'body' }],
      });
    }
    // La llave nace con prefijo del tenant: una de otro negocio no se manda
    // ni por error ni a propósito.
    if ((body.adjuntos ?? []).length > adjuntos.length) {
      throw new BadRequestException({
        code: 'ADJUNTO_INVALIDO',
        message: 'Solo se puede mandar un archivo por mensaje, y tiene que ser de este negocio.',
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      const conversation = await getConversation(c, actor.tenantId, id).catch(notFound);
      if (conversation.ownerId !== null && conversation.ownerId !== actor.userId
          && !actorCan(actor, 'conversations.read_all')) {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message: 'Esta conversación la atiende otra persona del equipo.',
        });
      }
      // La ventana se hace cumplir AQUÍ (#43, SPEC §11) y es por canal (#74):
      // fuera de ella, WhatsApp solo deja salir plantillas aprobadas (#44), y
      // en Instagram y Messenger hacen falta etiquetas de mensaje.
      if (!isWithinWindow(conversation.channel, conversation.lastInboundAt)) {
        throw new UnprocessableEntityException({
          code: 'OUTSIDE_WINDOW',
          message:
            conversation.channel === 'whatsapp'
              ? 'Pasaron más de 24 horas desde su último mensaje: por WhatsApp solo salen plantillas aprobadas.'
              : 'Pasaron más de 24 horas desde su último mensaje: este canal ya no deja responder hasta que escriba de nuevo.',
        });
      }
      return entregarRespuesta(c, {
        actor,
        conversationId: id,
        conversation,
        texto: body.body?.trim() ?? '',
        type: (body.type as MessageType) ?? 'texto',
        ...(adjuntos.length ? { adjuntos } : {}),
        requestId: request.requestId,
      });
    });
  }

  @Post(':id/messages/:mid/retry-delivery')
  @RequirePermission('conversations.reply')
  @ApiOperation({ summary: 'Recupera el despacho agotado de un mensaje pendiente; no crea otro mensaje' })
  async retryDelivery(
    @Req() request: WithUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('mid', new ParseUUIDPipe()) messageId: string,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async c => {
      const conversation = await getConversation(c, actor.tenantId, id, true).catch(notFound);
      if (conversation.ownerId !== null && conversation.ownerId !== actor.userId
          && !actorCan(actor, 'conversations.read_all')) {
        throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Esta conversación la atiende otra persona del equipo.' });
      }
      try {
        return await retryOutboundDelivery(c, {
          tenantId: actor.tenantId, conversationId: id, messageId, actor: actor.userId,
          actorKind: actor.kind === 'apikey' ? 'apikey' : 'user', requestId: request.requestId,
        });
      } catch (error) {
        if (error instanceof OutboundRetryError) {
          throw new ConflictException({ code: 'DELIVERY_NOT_RETRYABLE', message: error.message });
        }
        throw error;
      }
    });
  }

  @Post(':id/assign')
  @RequirePermission('conversations.assign')
  @ApiOperation({ summary: 'Asigna o reasigna la conversación, con motivo' })
  async assign(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(Asignacion) body: z.infer<typeof Asignacion>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      await getConversation(c, actor.tenantId, id).catch(notFound);
      return assignConversation(c, {
        tenantId: actor.tenantId,
        conversationId: id,
        toOwnerId: body.toOwnerId,
        reason: body.reason,
        actor: actor.userId,
        requestId: request.requestId,
      });
    });
  }

  @Post(':id/state')
  @RequirePermission('conversations.resolve')
  @ApiOperation({ summary: 'Cambia el estado (resolver, posponer, reabrir)' })
  async state(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(NuevoEstado) body: z.infer<typeof NuevoEstado>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      await getConversation(c, actor.tenantId, id).catch(notFound);
      try {
        return await changeConversationState(c, {
          tenantId: actor.tenantId,
          conversationId: id,
          state: body.state as ConversationState,
          snoozedUntil: body.snoozedUntil ? new Date(body.snoozedUntil) : undefined,
          actor: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({
          code: 'INVALID_TRANSITION',
          message: (err as Error).message,
        });
      }
    });
  }

  // --- El copiloto en assist (#48): el humano manda con un toque ---

  /**
   * La sugerencia vigente y, si no hay, POR QUÉ no la hay (#436).
   *
   * El copiloto se salta el trabajo en varios casos legítimos y el motivo
   * se devolvía en el resultado del job, que no mira nadie. Desde la
   * bandeja, las cinco causas se veían igual: el panel vacío.
   *
   * El motivo se calcula solo cuando NO hay sugerencia: en el camino bueno
   * —que es el de siempre— no cuesta ni una consulta más.
   */
  @Get(':id/suggestion')
  @RequireModule('agents')
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'La sugerencia vigente del copiloto, o por qué no hay' })
  async suggestion(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const sugerencia = await pendingSuggestion(c, actor.tenantId, id);
      if (sugerencia) return { sugerencia, motivo: null };
      const motivo = await porQueNoHaySugerencia(c, {
        tenantId: actor.tenantId,
        conversationId: id,
      });
      return { sugerencia: null, motivo };
    });
  }

  @Post(':id/suggestions/:sid/send')
  @RequirePermission('conversations.reply')
  @ApiOperation({ summary: 'Envía la sugerencia tal cual — un toque' })
  async sendSuggestion(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Param('sid') sid: string,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const conversation = await getConversation(c, actor.tenantId, id).catch(notFound);
      if (!isWithinWindow(conversation.channel, conversation.lastInboundAt)) {
        throw new UnprocessableEntityException({
          code: 'OUTSIDE_WINDOW',
          message:
            conversation.channel === 'whatsapp'
              ? 'Pasaron más de 24 horas desde su último mensaje: por WhatsApp solo salen plantillas aprobadas.'
              : 'Pasaron más de 24 horas desde su último mensaje: este canal ya no deja responder hasta que escriba de nuevo.',
        });
      }
      let sugerencia;
      try {
        sugerencia = await resolveSuggestion(c, { tenantId: actor.tenantId, suggestionId: sid, status: 'sent' });
      } catch (err) {
        throw new BadRequestException({ code: 'SUGGESTION_GONE', message: (err as Error).message });
      }
      if (sugerencia.conversationId !== id) notFound();
      return entregarRespuesta(c, {
        actor,
        conversationId: id,
        conversation,
        texto: sugerencia.text,
        type: 'texto',
        requestId: request.requestId,
      });
    });
  }

  @Post(':id/suggestions/:sid/dismiss')
  @RequireModule('agents')
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Descarta la sugerencia' })
  async dismissSuggestion(@Req() request: WithUser, @Param('id') id: string, @Param('sid') sid: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        const s = await resolveSuggestion(c, { tenantId: actor.tenantId, suggestionId: sid, status: 'dismissed' });
        if (s.conversationId !== id) notFound();
        return { dismissed: true };
      } catch (err) {
        throw new BadRequestException({ code: 'SUGGESTION_GONE', message: (err as Error).message });
      }
    });
  }

  @Post(':id/suggestions/:sid/feedback')
  @RequireModule('agents')
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Pulgar arriba/abajo con motivo — alimenta la evaluación' })
  async suggestionFeedback(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Param('sid') sid: string,
    @Cuerpo(Calificacion) body: z.infer<typeof Calificacion>,
  ) {
    const actor = actorOf(request);
    await withTenant(pool(), actor.tenantId, (c) =>
      feedbackSuggestion(c, {
        tenantId: actor.tenantId,
        suggestionId: sid,
        feedback: body.feedback,
        reason: body.reason,
      }),
    ).catch((err) => {
      throw new BadRequestException({ code: 'SUGGESTION_GONE', message: (err as Error).message });
    });
    return { saved: true };
  }

  @Get(':id/analisis')
  @RequireModule('agents')
  @RequirePermission('conversations.read')
  @ApiOperation({ summary: 'Resumen, intención y calificación para la ficha' })
  async analisis(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const analisis = await conversationAnalysis(c, actor.tenantId, id);
      const agent = await activeAgent(c, actor.tenantId);
      const mode = agent ? await effectiveMode(c, agent, actor.tenantId, id) : 'off';
      return { ...analisis, mode };
    });
  }

  @Post(':id/agent-mode')
  @RequireModule('agents')
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'Piloto automático por conversación — jamás por defecto' })
  async agentMode(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(ModoDelAgente) body: z.infer<typeof ModoDelAgente>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      await getConversation(c, actor.tenantId, id).catch(notFound);
      await setConversationMode(c, {
        tenantId: actor.tenantId,
        conversationId: id,
        mode: body.mode,
        actor: actor.userId,
        requestId: request.requestId,
      });
      return { mode: body.mode };
    });
  }
}
