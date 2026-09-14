import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  UnprocessableEntityException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import { createQueue, redisConnection } from '@iaxti/core';
import {
  assignConversation,
  changeConversationState,
  getConversation,
  getConversationDetail,
  isWithinWindow,
  listInbox,
  listMessages,
  sendMessage,
  updateDeliveryStatus,
  retentionCutoff,
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
  resolveSuggestion,
  setConversationMode,
  type ConversationMode,
} from '@iaxti/module-agents';
import { RequireModule, RequirePermission } from './authz/decorators';
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

let colaOutbound: ReturnType<typeof createQueue> | null = null;
function outboundQueue(): ReturnType<typeof createQueue> {
  colaOutbound ??= createQueue('outbound', redisConnection());
  return colaOutbound;
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
    requestId: input.requestId,
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
  if (conversation.channel === 'whatsapp') {
    await outboundQueue().add(
      'send',
      {
        moduleId: 'whatsapp',
        tenantId: actor.tenantId,
        messageId: message.id,
        requestId: input.requestId,
      },
      { jobId: `out-${message.id}` },
    );
  }
  return message;
}

function notFound(): never {
  throw new NotFoundException({
    code: 'CONVERSATION_NOT_FOUND',
    message: 'No encontramos esa conversación. Puede que se haya archivado.',
  });
}

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
    @Body() body: { body?: string; type?: string },
  ) {
    const actor = actorOf(request);
    if (!body?.body?.trim()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Escribe el mensaje antes de enviarlo.',
        details: [{ field: 'body' }],
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
        texto: body.body!,
        type: (body.type as MessageType) ?? 'texto',
        requestId: request.requestId,
      });
    });
  }

  @Post(':id/assign')
  @RequirePermission('conversations.assign')
  @ApiOperation({ summary: 'Asigna o reasigna la conversación, con motivo' })
  async assign(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { toOwnerId?: string; reason?: string },
  ) {
    const actor = actorOf(request);
    if (!body?.toOwnerId) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Indica a quién se asigna la conversación.',
        details: [{ field: 'toOwnerId' }],
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      await getConversation(c, actor.tenantId, id).catch(notFound);
      return assignConversation(c, {
        tenantId: actor.tenantId,
        conversationId: id,
        toOwnerId: body.toOwnerId!,
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
    @Body() body: { state?: string; snoozedUntil?: string },
  ) {
    const actor = actorOf(request);
    if (!body?.state) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Indica el estado nuevo.',
        details: [{ field: 'state' }],
      });
    }
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

  @Get(':id/suggestion')
  @RequireModule('agents')
  @RequirePermission('agents.use')
  @ApiOperation({ summary: 'La sugerencia vigente del copiloto' })
  async suggestion(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      pendingSuggestion(c, actor.tenantId, id),
    );
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
    @Body() body: { feedback?: 'up' | 'down'; reason?: string },
  ) {
    const actor = actorOf(request);
    if (body?.feedback !== 'up' && body?.feedback !== 'down') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'El feedback es up o down.',
        details: [{ field: 'feedback' }],
      });
    }
    await withTenant(pool(), actor.tenantId, (c) =>
      feedbackSuggestion(c, {
        tenantId: actor.tenantId,
        suggestionId: sid,
        feedback: body.feedback!,
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
    @Body() body: { mode?: string },
  ) {
    const actor = actorOf(request);
    if (!['assist', 'autonomous', 'off'].includes(body?.mode ?? '')) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'El modo es assist, autonomous u off.',
        details: [{ field: 'mode' }],
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      await getConversation(c, actor.tenantId, id).catch(notFound);
      await setConversationMode(c, {
        tenantId: actor.tenantId,
        conversationId: id,
        mode: body.mode as ConversationMode,
        actor: actor.userId,
        requestId: request.requestId,
      });
      return { mode: body.mode };
    });
  }
}
