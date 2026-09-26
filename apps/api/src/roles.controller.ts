import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  assignRole,
  createCustomRole,
  listRoles,
  updateCustomRolePermissions,
} from '@iaxti/module-authorization';
import { z } from 'zod';
import { RequirePermission } from './authz/decorators';
import { Cuerpo, textoRequerido } from './validar';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';
import { registry } from './registry';
import { nadiePorEncimaDeSiMismo } from './authz/no-por-encima';
import type { PoolClient } from 'pg';

// Roles personalizados (#73): "recepcionista", "contador" y "socio" —
// clonar un base y editar permisos del catálogo. Los base, inmutables.

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

/**
 * El cuerpo de asignar un rol (#524).
 *
 * El mismo mensaje en los dos campos porque así estaba escrito: quien asigna
 * elige persona y rol en la misma pantalla y da igual cuál de los dos falte.
 * Los `details` lo dicen campo por campo.
 *
 * Sin `idRequerido` a propósito: hoy un id con cualquier forma llega al módulo
 * y vuelve como ROLE_INVALID. Exigir uuid acá cambiaría ese código por
 * VALIDATION_ERROR, y el contrato no se mueve para ahorrar una vuelta.
 */
const FALTAN_PERSONA_Y_ROL = 'Faltan la persona y el rol.';

const AsignacionDeRol = z.object({
  userId: textoRequerido(FALTAN_PERSONA_Y_ROL),
  roleId: textoRequerido(FALTAN_PERSONA_Y_ROL),
});

// Crear y editar siguen con `@Body()`: ahí no hay ningún VALIDATION_ERROR que
// mover. El nombre, el rol que se clona y la lista de permisos los valida
// `@iaxti/module-authorization` contra el catálogo, y lo que sale es
// ROLE_INVALID. Un esquema los rechazaría antes con otro `code`.
@ApiTags('roles')
@Controller('roles')
export class RolesController {
  @Get()
  @RequirePermission('roles.read')
  @ApiOperation({ summary: 'Los roles del tenant: base (inmutables) y personalizados' })
  async list(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      listRoles(c, actor.tenantId, new Set(registry.permissionsCatalog().keys())),
    );
  }

  @Get('catalogo')
  @RequirePermission('roles.read')
  @ApiOperation({ summary: 'El catálogo de permisos con su módulo y estado' })
  catalogo() {
    return [...registry.permissionsCatalog().entries()]
      .filter(([p]) => !p.startsWith('platform.'))
      .map(([permission, moduleId]) => ({
        permission,
        moduleId,
        // Los de módulos apagados se muestran deshabilitados con explicación.
        active: registry.isActive(moduleId),
      }))
      .sort((a, b) => a.permission.localeCompare(b.permission));
  }

  @Post()
  @RequirePermission('roles.manage')
  @ApiOperation({ summary: 'Clona un rol base como personalizado' })
  async create(@Req() request: WithUser, @Body() body: { name?: string; cloneFrom?: string }) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      // Clonar ADMIN es conseguir los permisos de ADMIN, aunque el rol nuevo
      // todavía no esté asignado a nadie: después basta un `assign` (#567).
      // Si el origen no existe, se deja pasar: ese error lo dice createCustomRole
      // con su propio mensaje, y adelantarlo acá diría otra cosa.
      const origen = await rolPorNombre(c, actor.tenantId, body?.cloneFrom ?? '');
      if (origen) {
        await nadiePorEncimaDeSiMismo(c, actor, {
          rol: origen.name,
          permisos: origen.permissions,
          accion: 'clonar ese rol',
        });
      }
      try {
        return await createCustomRole(c, {
          tenantId: actor.tenantId,
          name: body?.name ?? '',
          cloneFrom: body?.cloneFrom ?? '',
          catalog: new Set(registry.permissionsCatalog().keys()),
          actor: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'ROLE_INVALID', message: (err as Error).message });
      }
    });
  }

  @Put(':id')
  @RequirePermission('roles.manage')
  @ApiOperation({ summary: 'Edita los permisos de un rol personalizado' })
  async update(@Req() request: WithUser, @Param('id') id: string, @Body() body: { permissions?: string[] }) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      // Se comprueba el conjunto QUE SE PIDE, no el que el rol tiene hoy: el
      // agujero era agregarse `tenant.billing` a su propio rol (#567). Y de paso
      // esto también impide EDITAR un rol más poderoso que uno, que es correcto:
      // si no puedes repartir eso, tampoco decides qué reparte.
      const pedidos = body?.permissions ?? [];
      const rol = await rolPorId(c, actor.tenantId, id);
      await nadiePorEncimaDeSiMismo(c, actor, {
        rol: rol?.name ?? 'ese rol',
        permisos: [...pedidos, ...(rol?.permissions ?? [])],
        accion: 'cambiar sus permisos',
      });
      try {
        return await updateCustomRolePermissions(c, {
          tenantId: actor.tenantId,
          roleId: id,
          permissions: body?.permissions ?? [],
          catalog: new Set(registry.permissionsCatalog().keys()),
          actor: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'ROLE_INVALID', message: (err as Error).message });
      }
    });
  }

  @Post('assign')
  @RequirePermission('roles.manage')
  @ApiOperation({ summary: 'Asigna el rol a una persona del equipo (uno por tenant)' })
  async assign(
    @Req() request: WithUser,
    @Cuerpo(AsignacionDeRol) body: z.infer<typeof AsignacionDeRol>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      // Esta era la peor de las tres (#567): con solo `roles.manage` se podía
      // asignar cualquier rol a cualquiera, incluido a uno mismo. Y a diferencia
      // de la invitación —que necesita un correo, un enlace y que alguien
      // acepte— acá el cambio es inmediato y no hay a quién preguntarle.
      //
      // Da lo mismo si el destinatario es otra persona o uno mismo: lo que se
      // compara son los permisos del ROL contra los de quien lo reparte.
      const destino = await rolPorId(c, actor.tenantId, body.roleId);
      if (destino) {
        await nadiePorEncimaDeSiMismo(c, actor, {
          rol: destino.name,
          permisos: destino.permissions,
          accion: 'asignar ese rol',
        });
      }
      try {
        await assignRole(c, {
          tenantId: actor.tenantId,
          userId: body.userId,
          roleId: body.roleId,
          actor: actor.userId,
          requestId: request.requestId,
        });
        return { assigned: true };
      } catch (err) {
        throw new BadRequestException({ code: 'ROLE_INVALID', message: (err as Error).message });
      }
    });
  }
}

/**
 * Los roles asignables de este negocio, por nombre y por id.
 *
 * Se leen con `listRoles`, que ya excluye SUPERADMIN y filtra por el catálogo:
 * es el MISMO conjunto que se puede asignar, así que preguntarle a otra cosa
 * abriría la diferencia entre lo que se comprueba y lo que se reparte (#567).
 */
async function rolPorNombre(c: PoolClient, tenantId: string, nombre: string) {
  if (!nombre.trim()) return null;
  const catalogo = new Set(registry.permissionsCatalog().keys());
  return (await listRoles(c, tenantId, catalogo)).find((r) => r.name === nombre) ?? null;
}

async function rolPorId(c: PoolClient, tenantId: string, id: string) {
  const catalogo = new Set(registry.permissionsCatalog().keys());
  return (await listRoles(c, tenantId, catalogo)).find((r) => r.id === id) ?? null;
}
