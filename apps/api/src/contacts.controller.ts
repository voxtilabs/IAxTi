import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  completeActivity,
  createActivity,
  getContactFicha,
} from '@iaxti/module-crm';
import type { ActivityType } from '@iaxti/module-crm';
import { RequireModule, RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
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

const TIPOS: ActivityType[] = ['llamada', 'reunion', 'tarea', 'nota'];

/** La ficha de contacto (#32, SPEC §10/§29) y sus actividades. */
@ApiTags('crm')
@Controller('contacts')
@RequireModule('crm')
export class ContactsController {
  @Get(':id')
  @RequirePermission('crm.contacts.read')
  @ApiOperation({ summary: 'Ficha: contacto, oportunidades y actividades' })
  async ficha(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      getContactFicha(c, actor.tenantId, id),
    ).catch(() => {
      throw new NotFoundException({
        code: 'CONTACT_NOT_FOUND',
        message: 'No encontramos ese contacto. Puede que se haya eliminado.',
      });
    });
  }

  @Post(':id/activities')
  @RequirePermission('crm.activities.manage')
  @ApiOperation({ summary: 'Crea una actividad (llamada, reunión, tarea, nota)' })
  async crear(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { type?: string; title?: string; body?: string; dueAt?: string; dealId?: string },
  ) {
    const actor = actorOf(request);
    if (!TIPOS.includes(body?.type as ActivityType)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'La actividad es llamada, reunión, tarea o nota.',
        details: [{ field: 'type' }],
      });
    }
    if (!body?.title?.trim()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'La actividad necesita un título.',
        details: [{ field: 'title' }],
      });
    }
    return withTenant(pool(), actor.tenantId, (c) =>
      createActivity(c, {
        tenantId: actor.tenantId,
        contactId: id,
        dealId: body.dealId,
        type: body.type as ActivityType,
        title: body.title!,
        body: body.body,
        ownerId: actor.userId,
        dueAt: body.dueAt ? new Date(body.dueAt) : undefined,
      }),
    );
  }

  @Post('activities/:activityId/done')
  @RequirePermission('crm.activities.manage')
  @ApiOperation({ summary: 'Marca la actividad como hecha' })
  async listo(@Req() request: WithUser, @Param('activityId') activityId: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      completeActivity(c, { tenantId: actor.tenantId, activityId }),
    ).catch(() => {
      throw new NotFoundException({
        code: 'ACTIVITY_NOT_FOUND',
        message: 'No encontramos esa actividad.',
      });
    });
  }
}
