import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  contactTags,
  createTag,
  deleteTag,
  listTags,
  setContactTags,
  updateTag,
} from '@iaxti/module-crm';
import { RequireModule, RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

/**
 * Etiquetas del negocio (SPEC §10 y §23, issue 248).
 *
 * La tabla existía desde el primer día, el tablero ya filtraba por
 * etiquetas y la fusión de contactos las copiaba. Lo que no había era forma
 * de crear una: se podía filtrar por algo que nadie podía escribir.
 *
 * Leerlas es de cualquiera que vea contactos —se muestran en la ficha—;
 * administrar el catálogo es del ADMIN (`crm.tags.manage`), como dice la
 * matriz de §23: «editar pipelines, campos, etiquetas».
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
@Controller('tags')
@RequireModule('crm')
export class TagsController {
  @Get()
  @RequirePermission('crm.contacts.read')
  @ApiOperation({ summary: 'Etiquetas del negocio' })
  async list(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listTags(c, actor.tenantId));
  }

  @Post()
  @RequirePermission('crm.tags.manage')
  @ApiOperation({ summary: 'Crea una etiqueta con su color de rol' })
  async create(@Req() request: WithUser, @Body() body: { name?: string; role?: string }) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        createTag(c, { tenantId: actor.tenantId, name: body?.name ?? '', role: body?.role }),
      );
    } catch (err) {
      seVeMal(err);
    }
  }

  @Put(':id')
  @RequirePermission('crm.tags.manage')
  @ApiOperation({ summary: 'Renombra una etiqueta o le cambia el color' })
  async update(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { name?: string; role?: string },
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        updateTag(c, { tenantId: actor.tenantId, tagId: id, name: body?.name, role: body?.role }),
      );
    } catch (err) {
      seVeMal(err);
    }
  }

  @Delete(':id')
  @RequirePermission('crm.tags.manage')
  @ApiOperation({ summary: 'Borra una etiqueta y la quita de todos los contactos' })
  async remove(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        deleteTag(c, { tenantId: actor.tenantId, tagId: id }),
      );
    } catch (err) {
      seVeMal(err);
    }
  }

  /** Las de una persona, tal como las muestra su ficha. */
  @Get('contacto/:contactId')
  @RequirePermission('crm.contacts.read')
  @ApiOperation({ summary: 'Etiquetas de un contacto' })
  async deContacto(@Req() request: WithUser, @Param('contactId') contactId: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => contactTags(c, actor.tenantId, contactId));
  }

  /**
   * Deja al contacto EXACTAMENTE con estas etiquetas: se manda la lista
   * completa, que es como funciona la ficha (se marcan y desmarcan, y se
   * guarda lo que quedó). Etiquetar es parte de editar a la persona, no de
   * administrar el catálogo.
   */
  @Put('contacto/:contactId')
  @RequirePermission('crm.contacts.create')
  @ApiOperation({ summary: 'Deja al contacto con exactamente estas etiquetas' })
  async marcar(
    @Req() request: WithUser,
    @Param('contactId') contactId: string,
    @Body() body: { tagIds?: string[] },
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        setContactTags(c, {
          tenantId: actor.tenantId,
          contactId,
          tagIds: Array.isArray(body?.tagIds) ? body.tagIds : [],
          actor: actor.userId,
          requestId: (request as { requestId?: string }).requestId,
        }),
      );
    } catch (err) {
      seVeMal(err);
    }
  }
}
