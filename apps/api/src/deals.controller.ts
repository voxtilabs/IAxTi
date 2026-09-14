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
  createDeal,
  deleteSavedFilter,
  listDeals,
  listLossReasons,
  listPipelines,
  listSavedFilters,
  moveDealStage,
  saveFilter,
} from '@iaxti/module-crm';
import type { DealFilters } from '@iaxti/module-crm';
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
      cursor,
      limit: limit ? Number(limit) : undefined,
    };
    // §10/§23: USER ve lo suyo (y lo sin dueño) salvo "ver todo el CRM".
    if (owner === 'me') filters.ownerId = actor.userId;
    else if (!actorCan(actor, 'crm.read_all')) filters.ownerIdOrUnassigned = actor.userId;

    return withTenant(pool(), actor.tenantId, (c) => listDeals(c, actor.tenantId, filters));
  }

  @Post('deals')
  @RequirePermission('crm.deals.create')
  @ApiOperation({ summary: 'Crea una oportunidad (el copiloto la sugiere, el humano decide)' })
  async create(
    @Req() request: WithUser,
    @Body() body: { contactId?: string; pipelineId?: string; title?: string; value?: number },
  ) {
    const actor = actorOf(request);
    if (!body?.contactId || !body?.title?.trim()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'La oportunidad necesita contacto y título.',
        details: [{ field: !body?.contactId ? 'contactId' : 'title' }],
      });
    }
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
          contactId: body.contactId!,
          pipelineId,
          title: body.title!.trim(),
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
    @Body() body: { stageId?: string; reason?: string; lostReasonId?: string },
  ) {
    const actor = actorOf(request);
    if (!body?.stageId) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Indica la etapa de destino.',
        details: [{ field: 'stageId' }],
      });
    }
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        moveDealStage(c, {
          tenantId: actor.tenantId,
          dealId: id,
          stageId: body.stageId!,
          reason: body.reason,
          lostReasonId: body.lostReasonId,
          actor: actor.userId,
          requestId: request.requestId,
        }),
      );
    } catch (err) {
      const message = (err as Error).message;
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

  @Post('saved-filters')
  @RequirePermission('crm.deals.read')
  @ApiOperation({ summary: 'Guarda (o actualiza) un filtro con nombre' })
  async save(
    @Req() request: WithUser,
    @Body() body: { name?: string; view?: string; filters?: Record<string, unknown> },
  ) {
    const actor = actorOf(request);
    if (!body?.name?.trim()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Ponle nombre al filtro para guardarlo.',
        details: [{ field: 'name' }],
      });
    }
    return withTenant(pool(), actor.tenantId, (c) =>
      saveFilter(c, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        view: body.view === 'contacts' ? 'contacts' : 'deals',
        name: body.name!,
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
