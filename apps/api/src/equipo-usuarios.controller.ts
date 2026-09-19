import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  acceptInvitation,
  cancelarInvitacion,
  createInvitation,
  listarEquipo,
  listarInvitaciones,
  quitarDelEquipo,
} from '@iaxti/module-identity';
import { listRoles } from '@iaxti/module-authorization';
import { sendNotificationEmail } from '@iaxti/module-notifications';
import { RequireAuth, RequireModule, RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';
import { registry } from './registry';

// El equipo del negocio (SPEC §9). Las funciones de invitación existían
// desde la Fase 1 y NINGUNA ruta las exponía: se podía declarar el permiso
// `users.invite`, dárselo a un rol, y aun así no había forma de invitar a
// nadie. Un CRM multiusuario donde no se puede agregar la segunda persona
// es un CRM de una persona.

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

const CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

@ApiTags('equipo')
@Controller('equipo')
export class EquipoUsuariosController {
  @Get()
  @RequireModule('identity')
  @RequirePermission('users.read')
  @ApiOperation({ summary: 'Quién tiene acceso al negocio y con qué rol' })
  async equipo(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => ({
      miembros: await listarEquipo(c, actor.tenantId),
      invitaciones: await listarInvitaciones(c, actor.tenantId),
    }));
  }

  @Post('invitaciones')
  @RequireModule('identity')
  @RequirePermission('users.invite')
  @ApiOperation({ summary: 'Invita a alguien con un rol' })
  async invitar(@Req() request: WithUser, @Body() body: { email?: string; rol?: string }) {
    const actor = actorOf(request);
    const email = (body?.email ?? '').trim().toLowerCase();
    if (!CORREO.test(email)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Ese correo no se entiende.',
        details: [{ field: 'email' }],
      });
    }
    const rol = (body?.rol ?? '').trim().toUpperCase();

    return withTenant(pool(), actor.tenantId, async (c) => {
      // El rol tiene que existir DE VERDAD: invitar a un rol inventado crea
      // a alguien que entra y no puede hacer nada, y eso se descubre tarde.
      const roles = await listRoles(c, actor.tenantId, new Set(registry.permissionsCatalog().keys()));
      if (!roles.some((r) => r.name === rol)) {
        throw new BadRequestException({
          code: 'ROLE_UNKNOWN',
          message: `El rol "${rol}" no existe. Disponibles: ${roles.map((r) => r.name).join(', ')}.`,
        });
      }
      // Nadie invita por encima de sí mismo: un SUPERVISOR no crea ADMIN.
      if (rol === 'ADMIN' && actor.role !== 'ADMIN' && actor.role !== 'SUPERADMIN') {
        throw new BadRequestException({
          code: 'ROLE_FORBIDDEN',
          message: 'Solo quien administra el negocio puede invitar a otra persona como ADMIN.',
        });
      }

      const yaEsta = await c.query(
        `SELECT 1 FROM invitations
          WHERE tenant_id = $1 AND lower(email) = $2 AND accepted_at IS NULL
            AND expires_at > now()`,
        [actor.tenantId, email],
      );
      if ((yaEsta.rowCount ?? 0) > 0) {
        throw new BadRequestException({
          code: 'INVITATION_PENDING',
          message: 'Esa persona ya tiene una invitación pendiente.',
        });
      }

      const invitacion = await createInvitation(c, {
        tenantId: actor.tenantId,
        email,
        roleName: rol,
        actor: actor.userId,
        requestId: request.requestId,
      });

      // Mejor-esfuerzo: sin SMTP configurado la invitación existe igual y el
      // enlace se puede pasar a mano. Que no salga el correo no puede
      // deshacer lo que ya quedó en la base.
      const enlace = `${process.env.APP_URL_PUBLIC ?? ''}/invitacion/${invitacion.token}`;
      await sendNotificationEmail(c, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        title: 'Te invitaron a un negocio en IAxTi',
        body: `Entra con este enlace para aceptar la invitación: ${enlace}`,
        link: enlace,
        para: email,
      }).catch(() => undefined);

      return {
        id: invitacion.id,
        email,
        rol,
        expiraEl: invitacion.expiresAt,
        // El token viaja UNA vez: sirve para pasar el enlace a mano si el
        // correo no está configurado todavía.
        enlace,
      };
    });
  }

  @Delete('invitaciones/:id')
  @RequireModule('identity')
  @RequirePermission('users.invite')
  @ApiOperation({ summary: 'Cancela una invitación pendiente' })
  async cancelar(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    const ok = await withTenant(pool(), actor.tenantId, (c) =>
      cancelarInvitacion(c, { tenantId: actor.tenantId, invitationId: id }),
    );
    if (!ok) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Esa invitación no existe o ya fue usada.',
      });
    }
    return { cancelada: true };
  }

  @Delete('miembros/:userId')
  @RequireModule('identity')
  @RequirePermission('users.manage')
  @ApiOperation({ summary: 'Quita el acceso de una persona (su historial queda)' })
  async quitar(@Req() request: WithUser, @Param('userId') userId: string) {
    const actor = actorOf(request);
    try {
      await withTenant(pool(), actor.tenantId, (c) =>
        quitarDelEquipo(c, { tenantId: actor.tenantId, userId, actor: actor.userId }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'REMOVE_REJECTED', message: (err as Error).message });
    }
    return { quitado: true };
  }
}

/**
 * Aceptar una invitación (#28).
 *
 * Va en su propio controller y con `@RequireAuth` porque quien acepta
 * TODAVÍA NO ES MIEMBRO del negocio — eso es exactamente lo que la
 * invitación crea. Pedirle permiso sobre ese tenant sería pedirle lo que
 * viene a conseguir, y exigirle `X-Tenant-Id` sería pedirle que sepa a qué
 * negocio lo invitaron: el token ya lo dice.
 *
 * Sí necesita sesión: sin saber QUIÉN acepta, no hay a quién darle acceso.
 *
 * Esto faltaba entero. La invitación se creaba y devolvía un enlace
 * `/invitacion/<token>` que no llevaba a ninguna parte, y no había forma de
 * canjearlo. O sea que "Invita a tu equipo" —un paso del onboarding— no se
 * podía terminar aunque se mandara la invitación.
 */
/**
 * `acceptInvitation` sin `withTenant`, a propósito.
 *
 * Quien acepta no pertenece todavía a ningún tenant, así que no hay
 * `app.tenant_id` que fijar. La función resuelve el tenant desde el token y
 * escribe con `tenant_id` explícito — que es la regla del proyecto igual:
 * RLS es la segunda cerradura, no la primera.
 */
async function aceptarInvitacionConPool(
  p: ReturnType<typeof apiPool> extends null | infer T ? T : never,
  input: { token: string; userId: string; requestId?: string },
): Promise<{ tenantId: string; roleName: string }> {
  const client = await (p as { connect: () => Promise<import('pg').PoolClient> }).connect();
  try {
    return await acceptInvitation(client, input);
  } finally {
    client.release();
  }
}

@ApiTags('equipo')
@Controller('invitaciones')
export class InvitacionesController {
  @Post(':token/aceptar')
  @RequireAuth()
  @ApiOperation({ summary: 'Canjea una invitación y entra al negocio' })
  async aceptar(@Req() request: WithUser, @Param('token') token: string) {
    const user = request.user as { userId: string } | undefined;
    if (!user?.userId) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Necesitas iniciar sesión para aceptar la invitación.',
      });
    }
    try {
      // Sin `withTenant`: el tenant lo dice el token, y el usuario todavía
      // no pertenece a ninguno. `acceptInvitation` lo resuelve y escribe con
      // `tenant_id` explícito.
      const r = await aceptarInvitacionConPool(pool(), {
        token,
        userId: user.userId,
        requestId: (request as { requestId?: string }).requestId,
      });
      return r;
    } catch (err) {
      const message = (err as Error).message;
      // Los tres motivos por los que una invitación no sirve son distintos y
      // el que la recibe necesita saber cuál es: pedir otra, o avisar que ya
      // entró.
      if (/no existe|ya fue usada|venció/.test(message)) {
        throw new BadRequestException({ code: 'INVITATION_INVALID', message });
      }
      throw err;
    }
  }
}
