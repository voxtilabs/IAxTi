import {
  Controller,
  Delete,
  BadRequestException,
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
import { limitesDelCanal, revisarAdjunto } from '@iaxti/module-channels';
import {
  addInternalNote,
  createQuickReply,
  deleteQuickReply,
  getConversation,
  listInternalNotes,
  listQuickReplies,
  searchConversations,
} from '@iaxti/module-conversations';
import { z } from 'zod';
import { RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo, textoRequerido } from './validar';
import type { Actor, WithUser } from './authz/authz.guard';
import { actorCan } from './authz/can';
import { apiPool } from './db';
// El 404 de conversación se comparte en vez de copiarse: dos literales iguales
// en dos controllers se separan en el primer cambio de copy.
import { notFound } from './conversations.controller';

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

/**
 * El cuerpo de crear un atajo (#524).
 *
 * El mensaje es el MISMO en los dos campos porque así estaba escrito: quien
 * crea el atajo lo lee como una sola instrucción, y da igual cuál de los dos
 * falte.
 */
const NuevoAtajo = z.object({
  shortcut: textoRequerido('El atajo necesita nombre y texto.'),
  body: textoRequerido('El atajo necesita nombre y texto.'),
  // El ámbito se queda como estaba en el tipo. Que 'negocio' se pueda o no
  // NO va acá: depende del permiso de quien pide, y el esquema no conoce al
  // actor — eso sigue siendo un `if` abajo, con su PERMISSION_DENIED.
  scope: z.enum(['negocio', 'mio']).optional(),
});

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
    @Cuerpo(NuevoAtajo) body: z.infer<typeof NuevoAtajo>,
  ) {
    const actor = actorOf(request);
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
        shortcut: body.shortcut,
        body: body.body,
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

/** La nota interna: lo único que tiene que venir es el texto (#524). */
const NuevaNota = z.object({
  body: textoRequerido('Escribe la nota antes de guardarla.'),
  // A quiénes se menciona. No se comprueba que sigan en el equipo: una
  // mención a alguien que se fue no debería botar la nota.
  mentions: z.array(z.string()).optional(),
});

/** Dónde subir un adjunto: solo el nombre, la llave la arma la ruta (#524). */
const DestinoDeAdjunto = z.object({
  filename: textoRequerido('Dinos el nombre del archivo.'),
  // El tipo y el peso son OBLIGATORIOS (#560): sin ellos no se puede revisar
  // nada antes de firmar la subida, y era justo eso lo que faltaba. Un cliente
  // que no los manda recibe un VALIDATION_ERROR y no una URL firmada — que es
  // lo contrario de antes, cuando cualquier cosa conseguía su URL.
  contentType: textoRequerido('Dinos de qué tipo es el archivo.'),
  sizeBytes: z
    .number({ error: 'Dinos cuánto pesa el archivo.' })
    .int('El peso va en bytes enteros.')
    .positive('Un archivo vacío no se puede mandar.'),
});

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
    @Cuerpo(NuevaNota) body: z.infer<typeof NuevaNota>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      await getConversation(c, actor.tenantId, id);
      return addInternalNote(c, {
        tenantId: actor.tenantId,
        conversationId: id,
        authorId: actor.userId,
        body: body.body,
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
    @Cuerpo(DestinoDeAdjunto) body: z.infer<typeof DestinoDeAdjunto>,
  ) {
    const actor = actorOf(request);
    const storage = storageFromEnv();
    if (!storage) {
      throw new ServiceUnavailableException({
        code: 'STORAGE_NOT_CONFIGURED',
        message: 'El almacenamiento de adjuntos aún no está configurado en este ambiente.',
      });
    }
    const conversation = await withTenant(pool(), actor.tenantId, (c) =>
      getConversation(c, actor.tenantId, id),
    ).catch(notFound);
    // La revisión va ANTES de firmar: firmar es dar permiso de escribir en el
    // bucket del negocio, y darlo para un archivo que jamás va a salir se paga
    // en almacenamiento y se cobra en tiempo de quien atiende (#560).
    const revision = revisarAdjunto(
      { contentType: body.contentType, sizeBytes: body.sizeBytes },
      conversation.channel,
    );
    if (!revision.ok) {
      throw new BadRequestException({ code: revision.code, message: revision.message });
    }
    const key = attachmentKey(actor.tenantId, id, body.filename);
    return {
      key,
      uploadUrl: presignUrl(storage, 'PUT', key),
      expiresSeconds: 900,
    };
  }

  @Get('conversations/:id/attachments/limites')
  @RequirePermission('conversations.reply')
  @ApiOperation({
    summary: 'Qué puede adjuntar esta conversación: tipos aceptados y peso máximo',
  })
  async limitesDeAdjunto(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    // La interfaz PIDE los límites, no los copia (#560). Una tabla duplicada en
    // el front se separa de la de acá en el primer cambio, y entonces ofrece
    // subir algo que esta misma ruta va a rechazar.
    const conversation = await withTenant(pool(), actor.tenantId, (c) =>
      getConversation(c, actor.tenantId, id),
    ).catch(notFound);
    return {
      canal: conversation.channel,
      limites: limitesDelCanal(conversation.channel).map((l) => ({
        clase: l.clase,
        nombre: l.nombre,
        maxBytes: l.maxBytes,
        tipos: l.tipos,
      })),
    };
  }

  @Get('attachments/url')
  @RequirePermission('conversations.read')
  @ApiOperation({ summary: 'URL prefirmada para bajar un adjunto del tenant' })
  async presignDownload(@Req() request: WithUser, @Query('key') key?: string) {
    const actor = actorOf(request);
    // La llave nace con prefijo por tenant: fuera de él no se firma nada. No
    // va a un esquema (#524): depende del tenant de quien pide, que el esquema
    // no conoce, y su respuesta es ATTACHMENT_NOT_FOUND —no decimos si la
    // llave de otro negocio existe— así que tampoco es un VALIDATION_ERROR.
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
