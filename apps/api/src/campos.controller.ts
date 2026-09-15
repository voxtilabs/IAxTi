import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  createCustomField,
  deleteCustomField,
  listCustomFields,
  type EntidadConCampos,
} from '@iaxti/module-crm';
import { RequireModule, RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

/**
 * Campos personalizados (SPEC §10 y §23, issue 248).
 *
 * La tabla estaba desde el primer día con los seis tipos y sus banderas, y
 * el catálogo de permisos anotaba `crm.fields.manage` como «no construido».
 * Mientras tanto, lo que cada rubro necesita —la talla, la patente, el
 * número de ficha— terminaba en `contacts.custom`, un saco libre donde nadie
 * declara nada.
 */
function pool() {
  const p = apiPool();
  if (!p) throw new BadRequestException({ code: 'DB_NOT_CONFIGURED', message: 'Sin base de datos.' });
  return p;
}

function actorOf(request: WithUser): Actor {
  return request.actor as Actor;
}

function seVeMal(err: unknown): never {
  throw new BadRequestException({ code: 'VALIDATION_ERROR', message: (err as Error).message });
}

@ApiTags('crm')
@Controller('campos')
@RequireModule('crm')
export class CamposController {
  @Get()
  @RequirePermission('crm.contacts.read')
  @ApiOperation({ summary: 'Campos personalizados declarados' })
  async list(@Req() request: WithUser, @Query('entidad') entidad?: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      listCustomFields(c, actor.tenantId, entidad as EntidadConCampos | undefined),
    );
  }

  @Post()
  @RequirePermission('crm.fields.manage')
  @ApiOperation({ summary: 'Declara un campo personalizado' })
  async create(
    @Req() request: WithUser,
    @Body()
    body: {
      entity?: string;
      label?: string;
      type?: string;
      required?: boolean;
      visibleIa?: boolean;
      options?: string[];
    },
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        createCustomField(c, {
          tenantId: actor.tenantId,
          entity: body?.entity ?? 'contact',
          label: body?.label ?? '',
          type: body?.type ?? 'texto',
          required: body?.required,
          visibleIa: body?.visibleIa,
          options: body?.options,
        }),
      );
    } catch (err) {
      seVeMal(err);
    }
  }

  /**
   * Quitar la definición NO borra lo que el negocio ya guardó: eso queda
   * como valor suelto hasta que alguien edite la ficha. Borrarle datos a
   * alguien por cambiar una definición sería una sorpresa fea.
   */
  @Delete(':id')
  @RequirePermission('crm.fields.manage')
  @ApiOperation({ summary: 'Quita la definición de un campo (no borra lo guardado)' })
  async remove(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    try {
      await withTenant(pool(), actor.tenantId, (c) =>
        deleteCustomField(c, { tenantId: actor.tenantId, fieldId: id }),
      );
      return { ok: true };
    } catch (err) {
      seVeMal(err);
    }
  }
}
