import { textoDeEntorno } from '@iaxti/core';
import {
  BadRequestException,
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
import { z } from 'zod';
import { RequireAuth, RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo } from './validar';
import { nadiePorEncimaDeSiMismo } from './authz/no-por-encima';
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

/**
 * El cuerpo de una invitación (#524).
 *
 * `trim` y `toLowerCase` van EN el esquema y en ese orden: el correo se
 * normaliza ANTES de comprobarlo y después viaja normalizado al resto de la
 * ruta —la consulta de pendientes compara `lower(email)` y la respuesta
 * devuelve ese mismo valor—. Dos mayúsculas distintas no son dos personas.
 *
 * El rol no se comprueba acá: los roles son los del negocio, salen de la base
 * y el esquema no conoce a quien pide. Que exista es ROLE_UNKNOWN y que no sea
 * por encima de quien invita es ROLE_FORBIDDEN, los dos más abajo con su
 * propio código.
 */


const NuevaInvitacion = z.object({
  email: z
    .string({ error: 'Ese correo no se entiende.' })
    .trim()
    .toLowerCase()
    .regex(CORREO, 'Ese correo no se entiende.'),
  // Con mensaje propio y no el de zod: sin él, un `rol: 42` respondía «Invalid
  // input: expected string, received number» a alguien que está invitando a
  // una persona de su equipo. Cuál rol existe de verdad lo decide la rama
  // ROLE_UNKNOWN de abajo, que necesita la lista del negocio y por eso no
  // puede vivir en el esquema.
  rol: z.string({ error: 'Dinos el rol de la persona que invitas.' }).optional(),
});

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
  async invitar(
    @Req() request: WithUser,
    @Cuerpo(NuevaInvitacion) body: z.infer<typeof NuevaInvitacion>,
  ) {
    const actor = actorOf(request);
    // Ya viene sin espacios y en minúscula: lo dejó así el esquema.
    const email = body.email;
    const pedido = (body.rol ?? '').trim();

    return withTenant(pool(), actor.tenantId, async (c) => {
      // El rol tiene que existir DE VERDAD: invitar a un rol inventado crea
      // a alguien que entra y no puede hacer nada, y eso se descubre tarde.
      const roles = await listRoles(c, actor.tenantId, new Set(registry.permissionsCatalog().keys()));
      /**
       * Sin pasar a MAYÚSCULAS, que era otro defecto de la misma línea (#532).
       *
       * La ruta hacía `.toUpperCase()` —pensado para los roles base, que son
       * ADMIN, SUPERVISOR y USER— y los roles PROPIOS del negocio tienen nombre
       * libre: «Recepcionista», «Jefe de local». Así que invitar a cualquier rol
       * propio respondía ROLE_UNKNOWN y la función de #73 era inalcanzable desde
       * acá. Lo encontró la prueba de escalada: esperaba ROLE_FORBIDDEN y llegó
       * ROLE_UNKNOWN.
       *
       * Se compara sin distinguir mayúsculas —para que «admin» siga sirviendo—
       * y se usa el nombre TAL COMO está guardado de ahí en adelante.
       */
      const calzan = roles.filter((r) => r.name.toLowerCase() === pedido.toLowerCase());
      /**
       * Dos roles que solo difieren en mayúsculas: se pregunta, no se adivina.
       *
       * El índice único de `roles` es `(tenant_id, name)` y distingue
       * mayúsculas, así que un negocio puede tener «Jefe» y «jefe». Elegir el
       * primero del orden —`base DESC, created_at`— le daría al invitado el rol
       * MÁS VIEJO, que puede ser el más amplio, sin que nadie se enterara: el
       * permiso se comprueba contra el rol resuelto, así que no es una escalada,
       * pero sí es darle a alguien un rol que no era (#556).
       */
      if (calzan.length > 1) {
        throw new BadRequestException({
          code: 'ROLE_AMBIGUO',
          message:
            `Tienes más de un rol que se escribe "${pedido}" con distintas mayúsculas ` +
            `(${calzan.map((r) => r.name).join(', ')}). Escríbelo tal cual para que no quede duda.`,
          details: [{ field: 'rol' }],
        });
      }
      const destino = calzan[0];
      if (!destino) {
        throw new BadRequestException({
          code: 'ROLE_UNKNOWN',
          message: `El rol "${pedido}" no existe. Disponibles: ${roles.map((r) => r.name).join(', ')}.`,
        });
      }
      const rol = destino.name;
      /**
       * Nadie invita por encima de sí mismo (#532).
       *
       * Comparando PERMISOS y no nombres. Antes era
       * `rol === 'ADMIN' && actor.role !== 'ADMIN' && actor.role !== 'SUPERADMIN'`,
       * que es justo lo que ADR-0008 prohíbe — y además no veía el caso que
       * importa: un rol PROPIO del negocio (#73) que cargue más permisos que
       * quien invita. Un ADMIN puede crear «Jefe de local» con `users.invite`;
       * esa persona llegaba acá y el check solo le impedía invitar al rol
       * llamado literalmente ADMIN. Invitar a otro rol propio con más permisos
       * que el suyo pasaba sin problema.
       *
       * Y la rama del SUPERADMIN era código muerto: su conjunto son
       * `platform.*` y `audit.read`, así que nunca pasa el guard de
       * `users.invite` de esta ruta.
       *
       * Para los roles base no cambia nada: un ADMIN tiene todo lo que no es
       * `platform.*`, así que cualquier rol del negocio es un subconjunto suyo.
       */
      // La regla vive en `authz/no-por-encima.ts` y no acá (#567): había tres
      // puertas más al mismo sitio en `roles.controller.ts`, y copiarla habría
      // dejado cuatro versiones que se separan.
      await nadiePorEncimaDeSiMismo(c, actor, {
        rol,
        permisos: destino.permissions,
        accion: 'invitar a alguien con ese rol',
      });

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
      // El `?? ''` de antes (#575) dejaba el enlace RELATIVO —
      // `/invitacion/<token>` — cuando la variable venía en blanco, y el
      // compose de staging la pasa pelada (`${APP_URL_PUBLIC}`, sin `:?`).
      // Un enlace relativo dentro de un correo no lleva a ninguna parte: la
      // invitación existía en la base y era imposible de aceptar.
      const base = textoDeEntorno('APP_URL_PUBLIC', 'https://app-staging.iaxti.cl');
      const enlace = `${base}/invitacion/${invitacion.token}`;
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
 * El mismo texto que ya daba `acceptInvitation` cuando el token no existe:
 * quien recibe un enlace viejo no debería poder distinguir "no existe" de "no
 * la pude leer".
 */
const INVITACION_INEXISTENTE = 'Esa invitación no existe. Pide que te inviten de nuevo.';

/**
 * Canjear el token, con el tenant de la invitación en contexto (#370).
 *
 * Esto corría con una conexión SUELTA del pool, y el comentario que lo
 * justificaba estaba a medias: es verdad que quien acepta no pertenece todavía
 * a ningún tenant, y por eso no hay `X-Tenant-Id` que pedirle. Lo que no se
 * sigue de ahí es que la transacción pueda correr sin `app.tenant_id`.
 * `invitations` tiene RLS FORCE, así que con un rol que respete las políticas
 * —producción, y a donde va el resto— el SELECT devuelve cero filas y la
 * respuesta es «Esa invitación no existe. Pide que te inviten de nuevo.»: el
 * primer momento de un empleado en el producto, roto, sin nada que se pueda
 * arreglar del otro lado. Si esa lectura pasara, el INSERT en `user_roles`
 * chocaría igual con su WITH CHECK. Con el rol de hoy (superusuario) funciona
 * porque Postgres ni mira las políticas: la segunda cerradura no está puesta.
 *
 * El tenant NO se puede exigir desde afuera: el token es quien lo dice. Así
 * que son dos pasos, como los webhooks de canal y las API keys (#286): una
 * función SECURITY DEFINER que del token devuelve SOLO el tenant —ni el rol,
 * ni el correo, ni si está vencida— y después el canje completo dentro de
 * `withTenant`. Que la invitación sirva de verdad lo sigue decidiendo
 * `acceptInvitation` leyendo la fila bajo RLS.
 */
async function aceptarInvitacion(
  input: { token: string; userId: string; requestId?: string },
): Promise<{ tenantId: string; roleName: string }> {
  const r = await pool().query('SELECT tenant_de_invitacion($1) AS tenant', [input.token]);
  const tenantId = r.rows[0]?.tenant as string | null | undefined;
  if (!tenantId) throw new Error(INVITACION_INEXISTENTE);
  return withTenant(pool(), tenantId, (c) => acceptInvitation(c, input));
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
      // El tenant lo dice el token —el usuario todavía no pertenece a
      // ninguno—, y con él se entra por `withTenant`: sin `app.tenant_id`
      // `invitations` no se deja leer.
      const r = await aceptarInvitacion({
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
      // `Rol desconocido` entra acá también (#556): antes caía al rethrow y
      // salía un 500 sin `code` ni `requestId`, o sea fuera del formato único de
      // la plataforma justo en la pantalla donde alguien intenta entrar por
      // primera vez. Puede pasar si el rol se borró entre invitar y aceptar.
      if (/no existe|ya fue usada|venció|Rol desconocido/.test(message)) {
        throw new BadRequestException({ code: 'INVITATION_INVALID', message });
      }
      throw err;
    }
  }
}
