import {
  BadRequestException,
  ForbiddenException,
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
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  addStage,
  createDeal,
  deleteSavedFilter,
  deleteStage,
  InvalidListQuery,
  listDeals,
  listLossReasons,
  listPipelines,
  listSavedFilters,
  moveDealStage,
  renamePipeline,
  reorderStages,
  saveFilter,
  updateStage,
} from '@iaxti/module-crm';
import type { DealFilters } from '@iaxti/module-crm';
import { z } from 'zod';
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

const actorOf = (request: WithUser): Actor => request.actor as Actor;

/**
 * Los esquemas de entrada (#524), arriba y al lado de sus rutas.
 *
 * El mensaje va copiado tal cual estaba en el `if` que reemplazan: lo lee
 * alguien que está atendiendo a un cliente, no quien programa, y hay pruebas
 * que lo afirman.
 */

/** El cuerpo de POST /deals. */
const NuevaOportunidad = z.object({
  // El MISMO mensaje en los dos campos porque antes eran un solo `if` con un
  // solo texto, y el texto es el contrato. Cuál de los dos falta lo dice el
  // `details`, que es lo que pinta el formulario.
  //
  // `contactId` va como texto y no como uuid a propósito: un id con forma
  // rara hoy llega a la consulta y vuelve como DEAL_INVALID. Validarlo acá lo
  // convertiría en VALIDATION_ERROR, y eso es mover el contrato.
  contactId: textoRequerido('La oportunidad necesita contacto y título.'),
  title: textoRequerido('La oportunidad necesita contacto y título.'),
  // Sin pipeline, la ruta toma el primero del negocio (y si no hay, avisa con
  // su propio código).
  pipelineId: z.string().optional(),
  value: z.number('El monto va en número.').optional(),
});

/** El cuerpo de POST /deals/:id/stage. */
const CambioDeEtapa = z.object({
  stageId: textoRequerido('Indica la etapa de destino.'),
  // El motivo NO se exige acá: cuándo hace falta —retroceder, perder— lo sabe
  // el módulo mirando el tipo de la etapa de destino, que el esquema no ve.
  // Sigue saliendo como INVALID_MOVE.
  reason: z.string().optional(),
  lostReasonId: z.string().optional(),
});

/** El cuerpo de POST /saved-filters. */
const FiltroGuardado = z.object({
  name: textoRequerido('Ponle nombre al filtro para guardarlo.'),
  // `view` queda como texto libre: la ruta normaliza a 'deals' cualquier cosa
  // que no sea 'contacts', y una lista cerrada acá rechazaría lo que hoy pasa.
  view: z.string().optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
});

/** Tablero y lista de oportunidades (#33, SPEC §10/§29). */
@ApiTags('crm')
@Controller()
@RequireModule('crm')
export class DealsController {
  @Get('pipelines')
  @RequirePermission('crm.deals.read')
  @ApiOperation({ summary: 'Pipelines del negocio con sus etapas' })
  async pipelines(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listPipelines(c, actor.tenantId));
  }

  @Get('loss-reasons')
  @RequirePermission('crm.deals.read')
  @ApiOperation({ summary: 'Motivos de pérdida configurados' })
  async lossReasons(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listLossReasons(c, actor.tenantId));
  }

  @Get('deals')
  @RequirePermission('crm.deals.read')
  @ApiOperation({ summary: 'Oportunidades con filtros y cursor' })
  @ApiQuery({ name: 'sort', required: false, enum: ['created', 'title', 'value', 'stage'] })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } })
  @ApiQuery({ name: 'pipelineId', required: false, type: String })
  @ApiQuery({ name: 'stageId', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'owner', required: false, type: String })
  @ApiQuery({ name: 'tag', required: false, type: String })
  @ApiQuery({ name: 'valueClpMin', required: false, type: String })
  @ApiQuery({ name: 'valueClpMax', required: false, type: String })
  @ApiQuery({ name: 'customKey', required: false, type: String })
  @ApiQuery({ name: 'customValue', required: false, type: String })
  async list(
    @Req() request: WithUser,
    @Query('pipelineId') pipelineId?: string,
    @Query('stageId') stageId?: string,
    @Query('status') status?: string,
    @Query('owner') owner?: string,
    @Query('tag') tag?: string,
    @Query('valueClpMin') valueClpMin?: string,
    @Query('valueClpMax') valueClpMax?: string,
    @Query('customKey') customKey?: string,
    @Query('customValue') customValue?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const actor = actorOf(request);
    const filters: DealFilters = {
      pipelineId,
      stageId,
      status: status as DealFilters['status'],
      tag: tag || undefined,
      valueClpMin: valueClpMin ? Number(valueClpMin) : undefined,
      valueClpMax: valueClpMax ? Number(valueClpMax) : undefined,
      custom: customKey && customValue !== undefined ? { key: customKey, value: customValue } : undefined,
      sort, order, cursor,
      limit: limit ? Number(limit) : undefined,
    };
    // §10/§23: USER ve lo suyo (y lo sin dueño) salvo "ver todo el CRM".
    if (owner === 'me') filters.ownerId = actor.userId;
    else if (!actorCan(actor, 'crm.read_all')) filters.ownerIdOrUnassigned = actor.userId;

    try {
      return await withTenant(pool(), actor.tenantId, (c) => listDeals(c, actor.tenantId, filters));
    } catch (e) {
      if (e instanceof InvalidListQuery) throw new BadRequestException({ code: 'INVALID_LIST_QUERY', message: e.message });
      throw e;
    }
  }

  @Post('deals')
  @RequirePermission('crm.deals.create')
  @ApiOperation({ summary: 'Crea una oportunidad (el copiloto la sugiere, el humano decide)' })
  async create(
    @Req() request: WithUser,
    @Cuerpo(NuevaOportunidad) body: z.infer<typeof NuevaOportunidad>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      let pipelineId = body.pipelineId;
      if (!pipelineId) {
        const pipes = await listPipelines(c, actor.tenantId);
        pipelineId = pipes[0]?.id;
        if (!pipelineId) {
          throw new BadRequestException({
            code: 'NO_PIPELINE',
            message: 'Primero crea un pipeline con sus etapas.',
          });
        }
      }
      try {
        return await createDeal(c, {
          tenantId: actor.tenantId,
          contactId: body.contactId,
          pipelineId,
          title: body.title,
          value: body.value,
          ownerId: actor.userId,
          actor: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'DEAL_INVALID', message: (err as Error).message });
      }
    });
  }

  @Post('deals/:id/stage')
  @RequirePermission('crm.deals.update')
  @ApiOperation({ summary: 'Mueve la oportunidad de etapa (motivo al retroceder)' })
  async move(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(CambioDeEtapa) body: z.infer<typeof CambioDeEtapa>,
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        moveDealStage(c, {
          tenantId: actor.tenantId,
          dealId: id,
          stageId: body.stageId,
          reason: body.reason,
          lostReasonId: body.lostReasonId,
          actor: actor.userId,
          requestId: request.requestId,
          // Cerrar es otra cosa que mover (#73): el catálogo declara
          // `crm.deals.close` aparte y hasta ahora no lo exigía nadie.
          puedeCerrar: () => actorCan(actor, 'crm.deals.close'),
        }),
      );
    } catch (err) {
      const message = (err as Error).message;
      if (message.startsWith('PERMISO_CERRAR: ')) {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message:
            'No tienes permiso para cerrar oportunidades. Puedes moverla entre etapas abiertas.',
        });
      }
      if (/No encontramos/.test(message)) {
        throw new NotFoundException({ code: 'DEAL_NOT_FOUND', message });
      }
      throw new BadRequestException({ code: 'INVALID_MOVE', message });
    }
  }

  @Get('saved-filters')
  @RequirePermission('crm.deals.read')
  @ApiOperation({ summary: 'Filtros guardados del usuario' })
  async filters(@Req() request: WithUser, @Query('view') view?: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      listSavedFilters(c, actor.tenantId, actor.userId, view === 'contacts' ? 'contacts' : 'deals'),
    );
  }

  /**
   * Editar el embudo (SPEC §23, issue 248). Los pipelines se creaban con el
   * configurador (#50) y quedaban congelados: un negocio que cambia su forma
   * de vender tenía que aguantar la que eligió el primer día.
   *
   * Borrar una etapa con oportunidades adentro se rechaza a propósito:
   * moverlas —¿se ganaron?, ¿se perdieron?, ¿siguen abiertas en otra?— es
   * una decisión del negocio, y tomarla por él le mentiría a sus números.
   *
   * Estas cuatro rutas se quedan con `@Body()` y sin esquema (#524): su
   * VALIDATION_ERROR no es una comprobación escrita acá, es el mensaje del
   * módulo tal como viene —«La etapa necesita un nombre.», «El nombre de la
   * etapa es muy largo (máximo 40).», «Ese pipeline no existe en este
   * negocio.»—. Un esquema tendría que repetir esos textos, la comprobación
   * del módulo seguiría estando igual, y el primer cambio en una de las dos
   * copias movería el contrato sin que nadie lo note.
   */
  @Put('pipelines/:id')
  @RequirePermission('crm.pipelines.manage')
  @ApiOperation({ summary: 'Renombra el pipeline' })
  async renombrarPipeline(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { name?: string },
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        renamePipeline(c, { tenantId: actor.tenantId, pipelineId: id, name: body?.name ?? '' }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: (err as Error).message });
    }
  }

  @Post('pipelines/:id/etapas')
  @RequirePermission('crm.pipelines.manage')
  @ApiOperation({ summary: 'Agrega una etapa antes del cierre' })
  async agregarEtapa(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { name?: string; expectedDays?: number },
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        addStage(c, {
          tenantId: actor.tenantId,
          pipelineId: id,
          name: body?.name ?? '',
          expectedDays: body?.expectedDays,
        }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: (err as Error).message });
    }
  }

  @Put('pipelines/:id/orden')
  @RequirePermission('crm.pipelines.manage')
  @ApiOperation({ summary: 'Reordena las etapas abiertas' })
  async reordenar(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { stageIds?: string[] },
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        reorderStages(c, {
          tenantId: actor.tenantId,
          pipelineId: id,
          stageIds: Array.isArray(body?.stageIds) ? body.stageIds : [],
        }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: (err as Error).message });
    }
  }

  @Put('etapas/:id')
  @RequirePermission('crm.pipelines.manage')
  @ApiOperation({ summary: 'Renombra la etapa o ajusta su probabilidad y días' })
  async editarEtapa(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { name?: string; probability?: number | null; expectedDays?: number | null },
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        updateStage(c, {
          tenantId: actor.tenantId,
          stageId: id,
          name: body?.name,
          probability: body?.probability,
          expectedDays: body?.expectedDays,
        }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: (err as Error).message });
    }
  }

  @Delete('etapas/:id')
  @RequirePermission('crm.pipelines.manage')
  @ApiOperation({ summary: 'Borra una etapa vacía' })
  async borrarEtapa(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    try {
      await withTenant(pool(), actor.tenantId, (c) =>
        deleteStage(c, { tenantId: actor.tenantId, stageId: id }),
      );
      return { ok: true };
    } catch (err) {
      throw new BadRequestException({ code: 'ETAPA_NO_VACIA', message: (err as Error).message });
    }
  }

  @Post('saved-filters')
  @RequirePermission('crm.deals.read')
  @ApiOperation({ summary: 'Guarda (o actualiza) un filtro con nombre' })
  async save(
    @Req() request: WithUser,
    @Cuerpo(FiltroGuardado) body: z.infer<typeof FiltroGuardado>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      saveFilter(c, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        view: body.view === 'contacts' ? 'contacts' : 'deals',
        name: body.name,
        filters: body.filters ?? {},
      }),
    );
  }

  @Delete('saved-filters/:id')
  @RequirePermission('crm.deals.read')
  @ApiOperation({ summary: 'Borra un filtro guardado propio' })
  async remove(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    await withTenant(pool(), actor.tenantId, (c) =>
      deleteSavedFilter(c, { tenantId: actor.tenantId, userId: actor.userId, id }),
    ).catch(() => {
      throw new NotFoundException({
        code: 'FILTER_NOT_FOUND',
        message: 'No encontramos ese filtro, o no es tuyo.',
      });
    });
    return { deleted: true };
  }
}
