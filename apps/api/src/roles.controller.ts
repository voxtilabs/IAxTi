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
