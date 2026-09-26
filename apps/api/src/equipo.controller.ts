import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { attachmentKey, presignUrl, storageFromEnv } from '@iaxti/core';
import {
  addInternalNote,
  createQuickReply,
  deleteQuickReply,
  getConversation,
  listInternalNotes,
  listQuickReplies,
  searchConversations,
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

const actorOf = (request: WithUser): Actor => request.actor as Actor;

/** Quick replies (SPEC §11): los del negocio + los personales de cada quien. */
@ApiTags('conversations')
@Controller('quick-replies')
@RequireModule('conversations')
export class QuickRepliesController {
  @Get()
  @RequirePermission('conversations.reply')
  @ApiOperation({ summary: 'Atajos del negocio y personales' })
  async list(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      listQuickReplies(c, actor.tenantId, actor.userId),
    );
  }

  @Post()
  @RequirePermission('conversations.reply')
  @ApiOperation({ summary: 'Crea un atajo (del negocio exige quickreplies.manage)' })
  async create(
    @Req() request: WithUser,
    @Body() body: { shortcut?: string; body?: string; scope?: 'negocio' | 'mio' },
  ) {
    const actor = actorOf(request);
    if (!body?.shortcut || !body?.body) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'El atajo necesita nombre y texto.',
        details: [{ field: !body?.shortcut ? 'shortcut' : 'body' }],
      });
    }
    const delNegocio = body.scope === 'negocio';
    if (delNegocio && !actorCan(actor, 'quickreplies.manage')) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'Los atajos del negocio los administra quien supervisa el equipo.',
      });
    }
    return withTenant(pool(), actor.tenantId, (c) =>
      createQuickReply(c, {
        tenantId: actor.tenantId,
        shortcut: body.shortcut!,
        body: body.body!,
        userId: delNegocio ? undefined : actor.userId,
      }),
    );
  }

  @Delete(':id')
  @RequirePermission('conversations.reply')
  @ApiOperation({ summary: 'Borra un atajo (ajeno exige quickreplies.manage)' })
  async remove(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    const puedeTodo = actorCan(actor, 'quickreplies.manage');
    await withTenant(pool(), actor.tenantId, (c) =>
      deleteQuickReply(c, {
        tenantId: actor.tenantId,
        id,
        userId: puedeTodo ? undefined : actor.userId,
      }),
    ).catch(() => {
      throw new NotFoundException({
        code: 'QUICK_REPLY_NOT_FOUND',
        message: 'No encontramos ese atajo, o no es tuyo.',
      });
    });
    return { deleted: true };
  }
}

/** Notas internas y búsqueda (SPEC §11). */
@ApiTags('conversations')
@Controller()
@RequireModule('conversations')
export class EquipoController {
  @Get('conversations/:id/notes')
  @RequirePermission('conversations.notes')
  @ApiOperation({ summary: 'Notas internas de la conversación (solo equipo)' })
  async notes(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      await getConversation(c, actor.tenantId, id);
      return listInternalNotes(c, actor.tenantId, id);
    });
  }

  @Post('conversations/:id/notes')
  @RequirePermission('conversations.notes')
  @ApiOperation({ summary: 'Agrega una nota interna con menciones' })
  async addNote(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { body?: string; mentions?: string[] },
  ) {
    const actor = actorOf(request);
    if (!body?.body?.trim()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Escribe la nota antes de guardarla.',
        details: [{ field: 'body' }],
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      await getConversation(c, actor.tenantId, id);
      return addInternalNote(c, {
        tenantId: actor.tenantId,
        conversationId: id,
        authorId: actor.userId,
        body: body.body!,
        mentions: body.mentions,
      });
    });
  }

  @Get('search')
  @RequirePermission('conversations.read')
  @ApiOperation({ summary: 'Búsqueda de texto completo en mensajes y notas' })
  async search(@Req() request: WithUser, @Query('q') q?: string, @Query('limit') limit?: string) {
    const actor = actorOf(request);
    if (!q?.trim()) return [];
    const ownerScope = actorCan(actor, 'conversations.read_all') ? undefined : actor.userId;
    return withTenant(pool(), actor.tenantId, (c) =>
      searchConversations(c, {
        tenantId: actor.tenantId,
        query: q,
        ownerScope,
        limit: limit ? Number(limit) : undefined,
      }),
    );
  }

  @Post('conversations/:id/attachments')
  @RequirePermission('conversations.reply')
  @ApiOperation({ summary: 'URL prefirmada para subir un adjunto a R2 (por tenant)' })
  async presignUpload(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { filename?: string },
  ) {
    const actor = actorOf(request);
    if (!body?.filename) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Dinos el nombre del archivo.',
        details: [{ field: 'filename' }],
      });
    }
    const storage = storageFromEnv();
    if (!storage) {
      throw new ServiceUnavailableException({
        code: 'STORAGE_NOT_CONFIGURED',
        message: 'El almacenamiento de adjuntos aún no está configurado en este ambiente.',
      });
    }
    await withTenant(pool(), actor.tenantId, (c) => getConversation(c, actor.tenantId, id));
    const key = attachmentKey(actor.tenantId, id, body.filename);
    return {
      key,
      uploadUrl: presignUrl(storage, 'PUT', key),
      expiresSeconds: 900,
    };
  }

  @Get('attachments/url')
  @RequirePermission('conversations.read')
  @ApiOperation({ summary: 'URL prefirmada para bajar un adjunto del tenant' })
  async presignDownload(@Req() request: WithUser, @Query('key') key?: string) {
    const actor = actorOf(request);
    // La llave nace con prefijo por tenant: fuera de él no se firma nada.
    if (!key || !key.startsWith(`${actor.tenantId}/`)) {
      throw new NotFoundException({
        code: 'ATTACHMENT_NOT_FOUND',
        message: 'No encontramos ese adjunto.',
      });
    }
    const storage = storageFromEnv();
    if (!storage) {
      throw new ServiceUnavailableException({
        code: 'STORAGE_NOT_CONFIGURED',
        message: 'El almacenamiento de adjuntos aún no está configurado en este ambiente.',
      });
    }
    return { url: presignUrl(storage, 'GET', key), expiresSeconds: 900 };
  }
}
