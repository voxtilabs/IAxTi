import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { withTenant } from '@iaxti/db';
import { leerConCache, olvidarEnCache } from '@iaxti/core';
import type { ActorKind } from '@iaxti/module-audit';
import {
  createCustomField,
  deleteCustomField,
  listCustomFields,
  updateCustomField,
  type EntidadConCampos,
} from '@iaxti/module-crm';
import { RequireModule, RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { Cuerpo } from './validar';
import { apiPool, apiRedis } from './db';

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

/**
 * Quién pide, en la forma que espera el caso de uso (#534).
 *
 * Es el ÚNICO lugar donde entra el actor de verdad: el módulo lo recibe como
 * un parámetro opcional, así que si el controlador no lo manda, nadie se
 * entera y el libro dice «system».
 *
 * `soporte` no aparece en el ternario y no es un olvido: el guard solo deja
 * pasar al modo soporte en GET/HEAD/OPTIONS y con un permiso de la lista
 * corta (`authz.guard.ts`, `PERMISOS_DE_SOPORTE` y `SOLO_LEE`), y las tres
 * rutas que escriben acá piden `crm.fields.manage`. Un actor de soporte no
 * llega a esta función.
 */
function quienPide(request: WithUser): { actor: string; actorKind: ActorKind; requestId?: string } {
  const actor = actorOf(request);
  return {
    actor: actor.userId,
    actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
    requestId: request.requestId,
  };
}

/**
 * Lo que se puede cambiar de un campo ya declarado (#534).
 *
 * Están las cuatro banderas y no `entity`, `key` ni `type`: cambiar esas tres
 * dejaría el dato ya guardado colgando de un nombre o un tipo que no existe
 * (el porqué, largo, está en `updateCustomField`).
 *
 * Y es `strictObject` —el único del repo— por el último criterio de #534: un
 * campo que se recibe y se descarta hace que quien llama crea que su cambio
 * entró. Un `PATCH {type: 'numero'}` que contesta 200 y no cambia el tipo es
 * peor que un 400 que dice que no se puede.
 */
const CampoEditable = z.strictObject(
  {
    label: z.string().trim().min(1, 'El campo necesita un nombre.').optional(),
    required: z.boolean().optional(),
    visibleIa: z.boolean().optional(),
    options: z.array(z.string()).optional(),
  },
  {
    error:
      'De un campo ya declarado se cambian la etiqueta, si es obligatorio, si lo ve la IA y las ' +
      'opciones. La entidad y el tipo no: el dato que ya guardaste quedaría colgando.',
  },
);

/**
 * Olvida la lista cacheada de este negocio, para las cuatro entidades.
 *
 * Se llama ANTES de escribir y no después: si la escritura falla, haber
 * olvidado el caché no hace daño —se vuelve a leer de la base—, mientras que
 * olvidar después deja una ventana en la que alguien lee lo viejo y lo guarda
 * otra vez por otros dos minutos.
 */
async function olvidarCampos(tenantId: string): Promise<void> {
  for (const entidad of ['todas', 'contact', 'company', 'deal']) {
    await olvidarEnCache(apiRedis(), { clave: `campos:${entidad}`, tenantId });
  }
}

@ApiTags('crm')
@Controller('campos')
@RequireModule('crm')
export class CamposController {
  /**
   * Cacheado en Redis (#711).
   *
   * Medido contra staging desde dentro del VPS: **postgres 64 ms** por consulta,
   * **redis 0 ms**. La base es Supabase y está lejos; Redis está al lado.
   *
   * Y esta lista es el caso de libro: la leen casi todas las pantallas del CRM
   * —la tabla de contactos, la ficha, la importación, la exportación— y cambia
   * cuando alguien declara un campo, o sea casi nunca.
   *
   * No lleva actor en la clave a propósito: los campos declarados son del
   * negocio y los ve igual cualquiera que tenga `crm.contacts.read`. Si algún
   * día la lista dependiera del rol, el actor tiene que entrar — un caché por
   * tenant que ignore el permiso filtra entre usuarios del mismo negocio.
   */
  @Get()
  @RequirePermission('crm.contacts.read')
  @ApiOperation({ summary: 'Campos personalizados declarados' })
  async list(@Req() request: WithUser, @Query('entidad') entidad?: string) {
    const actor = actorOf(request);
    return leerConCache(
      apiRedis(),
      { clave: `campos:${entidad ?? 'todas'}`, tenantId: actor.tenantId, ttlSegundos: 120 },
      () =>
        withTenant(pool(), actor.tenantId, (c) =>
          listCustomFields(c, actor.tenantId, entidad as EntidadConCampos | undefined),
        ),
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
      // Lo que se escribe olvida lo suyo (#711). Un caché que muestra lo viejo
      // después de guardar es peor que la lentitud que vino a arreglar: la
      // lentitud se nota y se aguanta; el dato viejo se cree.
      await olvidarCampos(actor.tenantId);
      return await withTenant(pool(), actor.tenantId, (c) =>
        createCustomField(c, {
          tenantId: actor.tenantId,
          entity: body?.entity ?? 'contact',
          label: body?.label ?? '',
          type: body?.type ?? 'texto',
          required: body?.required,
          visibleIa: body?.visibleIa,
          options: body?.options,
          // Quién declaró el campo (#534). Antes el caso de uso no recibía
          // actor, así que el registro no era incompleto: no existía.
          ...quienPide(request),
        }),
      );
    } catch (err) {
      seVeMal(err);
    }
  }

  /**
   * Corregir un campo ya declarado (#534).
   *
   * Faltaba entera: se podía declarar y quitar, no corregir. Así que
   * arreglar un «visible para la IA» marcado por error obligaba a borrar el
   * campo —que es lo que deja el valor suelto en cada ficha— y declararlo de
   * nuevo. La entidad y el tipo no se tocan: el motivo está en
   * `updateCustomField`.
   */
  @Patch(':id')
  @RequirePermission('crm.fields.manage')
  @ApiOperation({ summary: 'Cambia la etiqueta, la obligatoriedad, la visibilidad para la IA o las opciones' })
  async actualizar(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(CampoEditable) body: z.infer<typeof CampoEditable>,
  ) {
    const actor = actorOf(request);
    try {
      await olvidarCampos(actor.tenantId);
      return await withTenant(pool(), actor.tenantId, (c) =>
        updateCustomField(c, {
          tenantId: actor.tenantId,
          fieldId: id,
          label: body.label,
          required: body.required,
          visibleIa: body.visibleIa,
          options: body.options,
          ...quienPide(request),
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
      await olvidarCampos(actor.tenantId);
      await withTenant(pool(), actor.tenantId, (c) =>
        deleteCustomField(c, {
          tenantId: actor.tenantId,
          fieldId: id,
          ...quienPide(request),
        }),
      );
      return { ok: true };
    } catch (err) {
      seVeMal(err);
    }
  }
}
