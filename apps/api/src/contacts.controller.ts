import {
  BadRequestException,
  Body,
  Controller,
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
  completeActivity,
  confirmImport,
  createActivity,
  getContactFicha,
  listContacts,
  mergeContacts,
  previewImport,
} from '@iaxti/module-crm';
import type { ActivityType, ImportField } from '@iaxti/module-crm';
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
  @Get()
  @RequirePermission('crm.contacts.read')
  @ApiOperation({ summary: 'Contactos con búsqueda y cursor' })
  async list(
    @Req() request: WithUser,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      listContacts(c, actor.tenantId, { q, cursor, limit: limit ? Number(limit) : undefined }),
    );
  }

  /** Vista previa de importación (#34): valida fila por fila, NADA se escribe. */
  @Post('import/preview')
  @RequirePermission('crm.contacts.create')
  @ApiOperation({ summary: 'Vista previa del CSV: mapeo y validación fila a fila' })
  async importPreview(
    @Req() request: WithUser,
    @Body() body: { csv?: string; mapping?: Record<number, ImportField> },
  ) {
    const actor = actorOf(request);
    if (!body?.csv?.trim()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Pega o sube el contenido del CSV.',
        details: [{ field: 'csv' }],
      });
    }
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        previewImport(c, { tenantId: actor.tenantId, csv: body.csv!, mapping: body.mapping }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'IMPORT_ERROR', message: (err as Error).message });
    }
  }

  @Post('import/confirm')
  @RequirePermission('crm.contacts.create')
  @ApiOperation({ summary: 'Confirma la importación: crea las filas válidas' })
  async importConfirm(
    @Req() request: WithUser,
    @Body() body: { csv?: string; mapping?: Record<number, ImportField> },
  ) {
    const actor = actorOf(request);
    if (!body?.csv?.trim()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Pega o sube el contenido del CSV.',
        details: [{ field: 'csv' }],
      });
    }
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        confirmImport(c, {
          tenantId: actor.tenantId,
          csv: body.csv!,
          mapping: body.mapping,
          actor: actor.userId,
          requestId: request.requestId,
        }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'IMPORT_ERROR', message: (err as Error).message });
    }
  }

  /** Fusión (#34): solo SUPERVISOR/ADMIN (crm.contacts.merge, §23). */
  @Post(':id/merge')
  @RequirePermission('crm.contacts.merge')
  @ApiOperation({ summary: 'Fusiona un duplicado en este contacto' })
  async merge(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { duplicateId?: string },
  ) {
    const actor = actorOf(request);
    if (!body?.duplicateId) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Indica el contacto duplicado que se fusiona en este.',
        details: [{ field: 'duplicateId' }],
      });
    }
    try {
      await withTenant(pool(), actor.tenantId, (c) =>
        mergeContacts(c, {
          tenantId: actor.tenantId,
          primaryId: id,
          duplicateId: body.duplicateId!,
          actor: actor.userId,
          requestId: request.requestId,
        }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'MERGE_ERROR', message: (err as Error).message });
    }
    return { merged: true };
  }

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
