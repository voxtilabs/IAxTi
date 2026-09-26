import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import {
  addSource,
  deleteSource,
  embeddingsAvailable,
  getProduct,
  listSources,
  processSource,
  searchKnowledge,
  type SourceKind,
} from '@iaxti/module-knowledge';
import { RequireModule, RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

// knowledge (#51, SPEC §14): las fuentes del negocio con vigencia, y la
// búsqueda de prueba para que el dueño VEA qué encontraría la IA (con cita).

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
  return request.actor as Actor;
}

const KINDS: SourceKind[] = ['texto', 'pdf', 'url', 'faq', 'catalogo'];

@ApiTags('knowledge')
@Controller('knowledge')
@RequireModule('knowledge')
export class KnowledgeController {
  @Get('sources')
  @RequirePermission('knowledge.manage')
  @ApiOperation({ summary: 'Las fuentes de conocimiento del negocio' })
  async sources(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listSources(c, actor.tenantId));
  }

  @Post('sources')
  @RequirePermission('knowledge.manage')
  @ApiOperation({ summary: 'Agrega una fuente (texto, FAQ, catálogo CSV o URL) y la indexa' })
  async add(
    @Req() request: WithUser,
    @Body()
    body: {
      kind?: string;
      name?: string;
      content?: string;
      url?: string;
      validUntil?: string;
    },
  ) {
    const actor = actorOf(request);
    if (!KINDS.includes(body?.kind as SourceKind)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `El tipo de fuente es uno de: ${KINDS.join(', ')}.`,
        details: [{ field: 'kind' }],
      });
    }
    if (body.kind === 'pdf') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Los PDF se suben desde la app (llegan por archivo, no por texto).',
        details: [{ field: 'kind' }],
      });
    }
    if (!embeddingsAvailable()) {
      throw new ServiceUnavailableException({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'El proveedor de embeddings aún no tiene llave configurada en este ambiente.',
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      let source;
      try {
        source = await addSource(c, {
          tenantId: actor.tenantId,
          kind: body.kind as SourceKind,
          name: body.name ?? '',
          content: body.content,
          url: body.url,
          validUntil: body.validUntil ? new Date(body.validUntil) : null,
          actor: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'SOURCE_INVALID', message: (err as Error).message });
      }
      // Texto, FAQ, catálogo y URL se indexan al tiro (chico y síncrono).
      return processSource(c, {
        tenantId: actor.tenantId,
        sourceId: source.id,
        requestId: request.requestId,
      });
    });
  }

  @Post('sources/:id/reindex')
  @RequirePermission('knowledge.manage')
  @ApiOperation({ summary: 'Re-indexa la fuente (tras cambiarla)' })
  async reindex(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    if (!embeddingsAvailable()) {
      throw new ServiceUnavailableException({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'El proveedor de embeddings aún no tiene llave configurada en este ambiente.',
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        return await processSource(c, {
          tenantId: actor.tenantId,
          sourceId: id,
          requestId: request.requestId,
        });
      } catch (err) {
        // Solo el "no existe" es un 404. Antes este catch se tragaba
        // cualquier cosa —el proveedor caído, la base— y le decía al negocio
        // que su fuente no existía: se queda buscando un dato que está y el
        // problema era otro. Lo demás sube como 500 con su request id, que es
        // lo que se puede seguir en los logs.
        //
        // Ojo: un fallo DE LA FUENTE no llega acá. `processSource` lo atrapa,
        // deja la fuente en 'failed' con el motivo y la devuelve — el negocio
        // lo ve en la app, que es donde sirve.
        if ((err as Error).message === 'No encontramos esa fuente.') {
          throw new NotFoundException({
            code: 'SOURCE_NOT_FOUND',
            message: 'No encontramos esa fuente.',
          });
        }
        throw err;
      }
    });
  }

  @Delete('sources/:id')
  @RequirePermission('knowledge.manage')
  @ApiOperation({ summary: 'Elimina la fuente y todo su índice' })
  async remove(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        await deleteSource(c, {
          tenantId: actor.tenantId,
          sourceId: id,
          actor: actor.userId,
          requestId: request.requestId,
        });
      } catch {
        throw new NotFoundException({
          code: 'SOURCE_NOT_FOUND',
          message: 'No encontramos esa fuente.',
        });
      }
      return { deleted: true };
    });
  }

  @Get('search')
  @RequirePermission('knowledge.manage')
  @ApiOperation({ summary: 'Prueba qué encontraría la IA (con su cita)' })
  async search(@Req() request: WithUser, @Query('q') q?: string) {
    const actor = actorOf(request);
    if (!embeddingsAvailable()) {
      throw new ServiceUnavailableException({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'El proveedor de embeddings aún no tiene llave configurada en este ambiente.',
      });
    }
    return withTenant(pool(), actor.tenantId, (c) =>
      searchKnowledge(c, { tenantId: actor.tenantId, query: q ?? '' }),
    );
  }

  @Get('products')
  @RequirePermission('knowledge.read')
  @ApiOperation({ summary: 'La tool get_product: precio y stock como campos' })
  async products(@Req() request: WithUser, @Query('q') q?: string) {
    const actor = actorOf(request);
    if (!q?.trim()) return [];
    return withTenant(pool(), actor.tenantId, (c) => getProduct(c, actor.tenantId, q));
  }
}
