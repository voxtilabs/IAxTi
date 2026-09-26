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
import { knowledgeKey, presignUrl, storageFromEnv } from '@iaxti/core';
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

/** Solo PDF, y con tope: es lo que Gemini lee y lo que un negocio sube. */
const PDF_MAX_MB = 20;

function almacenamiento() {
  const storage = storageFromEnv();
  if (!storage) {
    throw new ServiceUnavailableException({
      code: 'STORAGE_NOT_CONFIGURED',
      message: 'El almacenamiento de archivos aún no está configurado en este ambiente.',
    });
  }
  return storage;
}

/**
 * Baja un archivo del negocio por su llave (#522).
 *
 * Va acá y no en el módulo: `knowledge` no conoce R2 ni firma nada. La llave
 * nace con el prefijo del tenant, y esto lo vuelve a comprobar antes de
 * firmar — el mismo resguardo que la ruta de bajar adjuntos.
 */
function bajarDelNegocio(tenantId: string) {
  return async (r2Key: string): Promise<Uint8Array> => {
    if (!r2Key.startsWith(`${tenantId}/`)) {
      throw new Error('Esa llave no es de este negocio.');
    }
    const res = await fetch(presignUrl(almacenamiento(), 'GET', r2Key));
    if (!res.ok) throw new Error(`No pudimos bajar el archivo guardado (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

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

  /**
   * Dónde subir un PDF (#522).
   *
   * Dos pasos y no uno: el archivo va del navegador DERECHO a R2 con una URL
   * firmada, sin pasar por la API. Un PDF de 20 MB por el cuerpo de una
   * petición es tiempo de servidor, memoria y un límite de tamaño que habría
   * que subir en Traefik y en Nest. Y el mismo camino ya lo usan los adjuntos
   * de la bandeja.
   */
  @Post('sources/pdf/destino')
  @RequirePermission('knowledge.manage')
  @ApiOperation({ summary: 'URL prefirmada para subir un PDF del conocimiento' })
  async destinoDelPdf(@Req() request: WithUser, @Body() body: { filename?: string; sizeBytes?: number }) {
    const actor = actorOf(request);
    const nombre = body?.filename?.trim();
    if (!nombre) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Dinos el nombre del archivo.',
        details: [{ field: 'filename' }],
      });
    }
    if (!/\.pdf$/i.test(nombre)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Por acá entran PDF. Para una planilla usa el catálogo, y para texto pégalo.',
        details: [{ field: 'filename' }],
      });
    }
    // El tope se comprueba ACÁ y no solo en el navegador: el navegador es de
    // quien sube, y una URL firmada aceptaría lo que le manden.
    if (body?.sizeBytes && body.sizeBytes > PDF_MAX_MB * 1024 * 1024) {
      throw new BadRequestException({
        code: 'ARCHIVO_MUY_GRANDE',
        message: `Ese PDF pesa más de ${PDF_MAX_MB} MB. Súbelo por partes o pega el texto.`,
        details: [{ field: 'sizeBytes' }],
      });
    }
    const key = knowledgeKey(actor.tenantId, nombre);
    return { key, uploadUrl: presignUrl(almacenamiento(), 'PUT', key), expiresSeconds: 900 };
  }

  /**
   * El PDF ya está subido: crea la fuente y la indexa (#522).
   *
   * La extracción del texto la hace Gemini (el catálogo de NVIDIA que sirve
   * GLM no tiene modelo multimodal), así que sin llave de Google esto avisa en
   * vez de dejar la fuente colgada.
   */
  @Post('sources/pdf')
  @RequirePermission('knowledge.manage')
  @ApiOperation({ summary: 'Registra e indexa un PDF ya subido' })
  async crearDesdePdf(
    @Req() request: WithUser,
    @Body() body: { key?: string; name?: string; validUntil?: string },
  ) {
    const actor = actorOf(request);
    const key = body?.key?.trim();
    // La llave la devolvió esta misma API, pero llega por el navegador: fuera
    // del prefijo del negocio no se toca nada.
    if (!key || !key.startsWith(`${actor.tenantId}/conocimiento/`)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Esa referencia de archivo no es válida. Vuelve a subir el PDF.',
        details: [{ field: 'key' }],
      });
    }
    if (!embeddingsAvailable()) {
      throw new ServiceUnavailableException({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'El proveedor de embeddings aún no tiene llave configurada en este ambiente.',
      });
    }
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      throw new ServiceUnavailableException({
        code: 'PROVIDER_UNAVAILABLE',
        message:
          'Leer PDF necesita el proveedor multimodal, que en este ambiente no tiene llave. Pega el texto por ahora.',
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      const source = await addSource(c, {
        tenantId: actor.tenantId,
        kind: 'pdf',
        // Sin nombre, el del archivo: la llave lleva un prefijo de tiempo
        // para no chocar, y eso no es un nombre que nadie quiera leer.
        name: body.name?.trim() || (key.split('/').pop() ?? 'Documento').replace(/^[a-z0-9]+-/, ''),
        r2Key: key,
        validUntil: body.validUntil ? new Date(body.validUntil) : null,
        actor: actor.userId,
        requestId: request.requestId,
      }).catch((err: Error) => {
        throw new BadRequestException({ code: 'SOURCE_INVALID', message: err.message });
      });
      return processSource(
        c,
        { tenantId: actor.tenantId, sourceId: source.id, requestId: request.requestId },
        { bajarArchivo: bajarDelNegocio(actor.tenantId) },
      );
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
        return await processSource(
          c,
          { tenantId: actor.tenantId, sourceId: id, requestId: request.requestId },
          // Con esto un PDF se reindexa sin volver a subirlo: el archivo ya
          // está guardado y hasta #522 nadie lo leía.
          { bajarArchivo: bajarDelNegocio(actor.tenantId) },
        );
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
