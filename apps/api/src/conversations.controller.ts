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
  isWithin24hWindow,
  listInbox,
  listMessages,
  sendMessage,
  updateDeliveryStatus,
} from '@iaxti/module-conversations';
import type {
  Channel,
  ConversationState,
  InboxFilters,
  MessageType,
} from '@iaxti/module-conversations';
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

    return withTenant(pool(), actor.tenantId, (c) => listInbox(c, actor.tenantId, filters));
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
      // La ventana de 24 h se hace cumplir AQUÍ (#43, SPEC §11): fuera de
      // ella, por WhatsApp solo salen plantillas aprobadas (llegan con #44).
      if (conversation.channel === 'whatsapp' && !isWithin24hWindow(conversation.lastInboundAt)) {
        throw new UnprocessableEntityException({
          code: 'OUTSIDE_WINDOW',
          message:
            'Pasaron más de 24 horas desde su último mensaje: por WhatsApp solo salen plantillas aprobadas.',
        });
      }
      // Responder desde la cola es tomarla: dueño + new → open (SPEC §11).
      if (conversation.ownerId === null) {
        await assignConversation(c, {
          tenantId: actor.tenantId,
          conversationId: id,
          toOwnerId: actor.userId,
          reason: 'respondió desde la bandeja',
          actor: actor.userId,
          requestId: request.requestId,
        });
      }
      const message = await sendMessage(c, {
        tenantId: actor.tenantId,
        conversationId: id,
        authorKind: 'user',
        authorId: actor.userId,
        type: (body.type as MessageType) ?? 'texto',
        body: body.body,
        requestId: request.requestId,
      });
      // Simulador y webchat entregan al instante (el widget sondea, #46).
      // WhatsApp va por la cola outbound con rate limit y reintentos (#43).
      if (conversation.channel === 'simulador' || conversation.channel === 'webchat') {
        return updateDeliveryStatus(c, {
          tenantId: actor.tenantId,
          messageId: message.id,
          status: 'sent',
          requestId: request.requestId,
        });
      }
      if (conversation.channel === 'whatsapp') {
        await outboundQueue().add(
          'send',
          {
            moduleId: 'whatsapp',
            tenantId: actor.tenantId,
            messageId: message.id,
            requestId: request.requestId,
          },
          { jobId: `out-${message.id}` },
        );
      }
      return message;
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
}
