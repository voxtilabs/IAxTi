import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  archiveCompany,
  asignarEmpresa,
  companyContacts,
  createCompany,
  getCompany,
  listCompanies,
  updateCompany,
} from '@iaxti/module-crm';
import { RequireModule, RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

/**
 * Empresas (SPEC §10, issue 248).
 *
 * La tabla existía desde el primer día con una clave foránea apuntándole
 * desde `contacts`, y no había forma de crear ninguna. Ver la empresa de un
 * contacto y colgarlo de una es de cualquiera que edite fichas; el catálogo
 * —crear, editar, archivar— es del ADMIN, igual que pipelines, campos y
 * etiquetas en la matriz de §23.
 *
 * Nada se borra: se archiva. Al archivar, los contactos que la tenían
 * quedan sueltos, porque una ficha que muestra una empresa que ya no está
 * en ninguna lista no se puede explicar.
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
  const mensaje = err instanceof Error ? err.message : 'No pudimos completar la operación.';
  throw new BadRequestException({ code: 'COMPANY_INVALID', message: mensaje, details: [] });
}

@ApiTags('empresas')
// Sin el `v1/`: lo pone `setGlobalPrefix('v1')` en main.ts, como a todos
// los demás. Con él, estas rutas vivían en /v1/v1/empresas — o sea que
// /v1/empresas, que es la que documenta el OpenAPI y la que el SDK genera,
// devolvía 404. El módulo entero estaba en una dirección que nadie iba a
// escribir.
@Controller('empresas')
@RequireModule('crm')
export class EmpresasController {
  @Get()
  @RequirePermission('crm.companies.read')
  @ApiOperation({ summary: 'Lista las empresas del negocio' })
  async list(
    @Req() request: WithUser,
    @Query('buscar') buscar?: string,
    @Query('archivadas') archivadas?: string,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      listCompanies(c, actor.tenantId, {
        buscar,
        incluirArchivadas: archivadas === 'true',
      }),
    );
  }

  @Get(':id')
  @RequirePermission('crm.companies.read')
  @ApiOperation({ summary: 'La ficha de una empresa con sus contactos' })
  async get(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, async (c) => ({
        ...(await getCompany(c, actor.tenantId, id)),
        contactos: await companyContacts(c, actor.tenantId, id),
      }));
    } catch (err) {
      seVeMal(err);
    }
  }

  @Post()
  @RequirePermission('crm.companies.manage')
  @ApiOperation({ summary: 'Crea una empresa' })
  async create(
    @Req() request: WithUser,
    @Body() body: { name: string; rut?: string | null; custom?: Record<string, unknown> },
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        createCompany(c, {
          tenantId: actor.tenantId,
          name: body?.name,
          rut: body?.rut,
          custom: body?.custom,
          actor: actor.userId,
          requestId: (request as { requestId?: string }).requestId,
        }),
      );
    } catch (err) {
      seVeMal(err);
    }
  }

  @Put(':id')
  @RequirePermission('crm.companies.manage')
  @ApiOperation({ summary: 'Edita una empresa' })
  async update(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { name?: string; rut?: string | null; custom?: Record<string, unknown> },
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        updateCompany(c, {
          tenantId: actor.tenantId,
          id,
          name: body?.name,
          rut: body?.rut,
          custom: body?.custom,
          actor: actor.userId,
          requestId: (request as { requestId?: string }).requestId,
        }),
      );
    } catch (err) {
      seVeMal(err);
    }
  }

  @Delete(':id')
  @RequirePermission('crm.companies.manage')
  @ApiOperation({ summary: 'Archiva una empresa (no se borra)' })
  async archive(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        archiveCompany(c, {
          tenantId: actor.tenantId,
          id,
          actor: actor.userId,
          requestId: (request as { requestId?: string }).requestId,
        }),
      );
    } catch (err) {
      seVeMal(err);
    }
  }
}

@ApiTags('empresas')
// Ídem. Y acá además convivía con el controller de contactos de verdad
// (`@Controller('contacts')`), que sí está bien: uno respondía en
// /v1/contacts y este en /v1/v1/contacts, sin que nada avisara.
@Controller('contacts')
@RequireModule('crm')
export class ContactoEmpresaController {
  @Put(':id/empresa')
  // Colgar un contacto de una empresa es editar el contacto, no administrar
  // el catálogo: por eso pide `contacts.update` y no `companies.manage`.
  @RequirePermission('crm.contacts.update')
  @ApiOperation({ summary: 'Asigna (o quita) la empresa de un contacto' })
  async asignar(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { companyId: string | null },
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        asignarEmpresa(c, {
          tenantId: actor.tenantId,
          contactId: id,
          companyId: body?.companyId ?? null,
          actor: actor.userId,
          requestId: (request as { requestId?: string }).requestId,
        }),
      );
    } catch (err) {
      seVeMal(err);
    }
  }
}
