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
import { z } from 'zod';
import { RequireModule, RequirePermission } from './authz/decorators';
import { actorCan } from './authz/can';
import { Cuerpo, textoRequerido } from './validar';
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

/**
 * Los esquemas de entrada (#524), arriba y al lado de sus rutas.
 *
 * El mensaje va escrito en cada uno porque lo lee quien está usando la app con
 * un cliente esperando, no quien programa.
 *
 * El mismo mensaje para las tres partes de la suscripción es a propósito: el
 * cuerpo no lo escribe una persona, lo arma el `PushManager` del navegador, y
 * saber CUÁL de los tres pedazos faltó no le sirve a quien lo lee. Los
 * `details` lo dicen igual, campo por campo.
 */
const PUSH_INCOMPLETA = 'La suscripción de push viene incompleta.';

const SuscripcionDePush = z.object({
  endpoint: textoRequerido(PUSH_INCOMPLETA),
  keys: z.object(
    {
      p256dh: textoRequerido(PUSH_INCOMPLETA),
      auth: textoRequerido(PUSH_INCOMPLETA),
    },
    // Sin esto, un cuerpo sin `keys` saldría con el mensaje de zod en inglés.
    { error: PUSH_INCOMPLETA },
  ),
});

const BajaDePush = z.object({
  endpoint: textoRequerido('Falta el endpoint.'),
});

/** Prender o apagar un canal no tiene tercer estado, y el `?? true` de la ruta
 *  necesita que lo que llegue sea booleano de verdad: antes el tipo del
 *  `@Body()` era una declaración, así que un `"false"` del navegador entraba
 *  como texto y quedaba guardado como prendido. */
const CANAL_NO_BOOLEANO = 'Cada canal del aviso va prendido o apagado.';

const PreferenciaDeAviso = z.object({
  // La lista sale del módulo y no de una copia: un aviso nuevo allá queda
  // válido acá sin tocar esta ruta.
  type: z.enum(NOTIFICATION_TYPES, { error: 'Ese tipo de aviso no existe.' }),
  campana: z.boolean({ error: CANAL_NO_BOOLEANO }).optional(),
  correo: z.boolean({ error: CANAL_NO_BOOLEANO }).optional(),
  push: z.boolean({ error: CANAL_NO_BOOLEANO }).optional(),
  whatsapp: z.boolean({ error: CANAL_NO_BOOLEANO }).optional(),
});

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

  /**
   * Esta ruta se queda con `@Body()` y sin esquema (#524): no tiene ningún
   * VALIDATION_ERROR que convertir. `ids` es opcional —sin ids marca todos— y
   * la consulta filtra por tenant y usuario, así que un id que no sea de quien
   * pide no marca nada. Ponerle esquema sería agregar una validación que hoy
   * no existe, y eso también mueve el contrato.
   */
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
    @Cuerpo(SuscripcionDePush) body: z.infer<typeof SuscripcionDePush>,
  ) {
    const actor = actorOf(request);
    await withTenant(pool(), actor.tenantId, (c) =>
      registerPushSubscription(c, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent: String(request.headers['user-agent'] ?? '').slice(0, 200),
      }),
    );
    return { subscribed: true };
  }

  @Delete('push')
  @RequirePermission('notifications.manage_own')
  @ApiOperation({ summary: 'Este navegador deja de recibir push' })
  async desuscribirPush(
    @Req() request: WithUser,
    @Cuerpo(BajaDePush) body: z.infer<typeof BajaDePush>,
  ) {
    const actor = actorOf(request);
    await withTenant(pool(), actor.tenantId, (c) =>
      deletePushSubscription(c, actor.tenantId, body.endpoint),
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
    @Cuerpo(PreferenciaDeAviso) body: z.infer<typeof PreferenciaDeAviso>,
  ) {
    const actor = actorOf(request);
    try {
      await withTenant(pool(), actor.tenantId, (c) =>
        setPreference(c, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          type: body.type,
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
