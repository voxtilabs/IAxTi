import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  NOTIFICATION_TYPES,
  getPreferences,
  listNotifications,
  markRead,
  setPreference,
} from '@iaxti/module-notifications';
import type { NotificationType } from '@iaxti/module-notifications';
import { RequireModule, RequirePermission } from './authz/decorators';
import { actorCan } from './authz/can';
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

/** La campana y las preferencias (#55): siempre de lo PROPIO. */
@ApiTags('notifications')
@Controller('notifications')
@RequireModule('notifications')
export class NotificationsController {
  @Get()
  @RequirePermission('notifications.manage_own')
  @ApiOperation({ summary: 'Mis avisos, con el contador de no leídos' })
  async list(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      listNotifications(c, actor.tenantId, actor.userId),
    );
  }

  @Post('read')
  @RequirePermission('notifications.manage_own')
  @ApiOperation({ summary: 'Marca leídos (ids concretos, o todos)' })
  async read(@Req() request: WithUser, @Body() body: { ids?: string[] }) {
    const actor = actorOf(request);
    const marked = await withTenant(pool(), actor.tenantId, (c) =>
      markRead(c, { tenantId: actor.tenantId, userId: actor.userId, ids: body?.ids }),
    );
    return { marked };
  }

  @Get('preferences')
  @RequirePermission('notifications.manage_own')
  @ApiOperation({ summary: 'Mis preferencias por tipo y canal' })
  async prefs(@Req() request: WithUser) {
    const actor = actorOf(request);
    // La "criticidad" bloquea solo a quien administra (ADMIN): el traductor
    // único decide si este actor tiene el paquete completo del tenant.
    const esAdmin = actorEsAdmin(actor);
    return withTenant(pool(), actor.tenantId, (c) =>
      getPreferences(c, actor.tenantId, actor.userId, esAdmin),
    );
  }

  @Put('preferences')
  @RequirePermission('notifications.manage_own')
  @ApiOperation({ summary: 'Guarda una preferencia (las críticas no se apagan)' })
  async setPref(
    @Req() request: WithUser,
    @Body() body: { type?: string; campana?: boolean; correo?: boolean },
  ) {
    const actor = actorOf(request);
    if (!NOTIFICATION_TYPES.includes(body?.type as NotificationType)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Ese tipo de aviso no existe.',
        details: [{ field: 'type' }],
      });
    }
    try {
      await withTenant(pool(), actor.tenantId, (c) =>
        setPreference(c, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          type: body.type as NotificationType,
          campana: body.campana ?? true,
          correo: body.correo ?? true,
          esAdmin: actorEsAdmin(actor),
        }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'PREFERENCE_REJECTED', message: (err as Error).message });
    }
    return { saved: true };
  }
}

/** ¿Este actor administra el tenant? Por el traductor único (ADR-0008):
 *  tenant.settings solo lo tiene el paquete de ADMIN. */
function actorEsAdmin(actor: Actor): boolean {
  return actorCan(actor, 'tenant.settings');
}
