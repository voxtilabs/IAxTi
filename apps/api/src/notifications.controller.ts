import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Delete,
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
  registerPushSubscription,
  deletePushSubscription,
  vapidFromEnv,
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

  @Post('push')
  @RequirePermission('notifications.manage_own')
  @ApiOperation({ summary: 'Registra este navegador para recibir push' })
  async suscribirPush(
    @Req() request: WithUser,
    @Body() body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } },
  ) {
    const actor = actorOf(request);
    const { endpoint } = body ?? {};
    const p256dh = body?.keys?.p256dh;
    const auth = body?.keys?.auth;
    if (!endpoint || !p256dh || !auth) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'La suscripción de push viene incompleta.',
        details: [{ field: 'endpoint' }],
      });
    }
    await withTenant(pool(), actor.tenantId, (c) =>
      registerPushSubscription(c, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        endpoint,
        p256dh,
        auth,
        userAgent: String(request.headers['user-agent'] ?? '').slice(0, 200),
      }),
    );
    return { subscribed: true };
  }

  @Delete('push')
  @RequirePermission('notifications.manage_own')
  @ApiOperation({ summary: 'Este navegador deja de recibir push' })
  async desuscribirPush(@Req() request: WithUser, @Body() body: { endpoint?: string }) {
    const actor = actorOf(request);
    if (!body?.endpoint) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Falta el endpoint.' });
    }
    await withTenant(pool(), actor.tenantId, (c) =>
      deletePushSubscription(c, actor.tenantId, body.endpoint!),
    );
    return { subscribed: false };
  }

  @Get('push/clave')
  @RequirePermission('notifications.manage_own')
  @ApiOperation({ summary: 'La llave pública VAPID para suscribirse' })
  clavePush() {
    const vapid = vapidFromEnv();
    // Sin llaves configuradas se dice, y el navegador ni pide permiso: pedir
    // permiso para algo que no puede llegar quema el permiso para siempre.
    return { publicKey: vapid?.publicKey ?? null };
  }

  @Put('preferences')
  @RequirePermission('notifications.manage_own')
  @ApiOperation({ summary: 'Guarda una preferencia (las críticas no se apagan)' })
  async setPref(
    @Req() request: WithUser,
    @Body()
    body: { type?: string; campana?: boolean; correo?: boolean; push?: boolean; whatsapp?: boolean },
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
          push: body.push ?? true,
          whatsapp: body.whatsapp ?? false,
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
