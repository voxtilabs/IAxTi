import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  ParseUUIDPipe,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { withTenant } from '@iaxti/db';
import { z } from 'zod';
import {
  ActivityReferenceError,
  completeActivity,
  confirmImport,
  createActivity,
  exportarContactos,
  exportarTitular,
  getContactFicha,
  InvalidListQuery,
  listActivities,
  listContacts,
  mergeContacts,
  previewImport,
  suprimirTitular,
  updateContact,
} from '@iaxti/module-crm';
import type { ActivityType, ImportField } from '@iaxti/module-crm';
import { RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo, textoRequerido } from './validar';
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

/**
 * Los cuatro tipos de actividad. Va con `satisfies` para que el día que el
 * dominio agregue o renombre uno, esto no compile en vez de aceptar un tipo
 * que la base no conoce.
 */
const TIPOS = ['llamada', 'reunion', 'tarea', 'nota'] as const satisfies readonly ActivityType[];

/**
 * Los esquemas de entrada (#524), al lado de sus rutas.
 *
 * El mensaje va escrito acá porque es lo que va a leer quien está atendiendo a
 * un cliente, no un «Required».
 */

/**
 * El CSV que se importa (#34). El esquema es uno porque la vista previa y la
 * confirmación reciben el MISMO cuerpo: la previa es la confirmación sin
 * escribir.
 */
const ImportacionDeCsv = z.object({
  csv: textoRequerido('Pega o sube el contenido del CSV.'),
  // El mapeo se acepta como vino, sin comprobar que cada valor sea un campo
  // importable: una columna mal rotulada ya la rechaza el caso de uso con
  // IMPORT_ERROR y su mensaje («Indica cuál columna es el teléfono»), y
  // meterla al esquema cambiaría ese código por VALIDATION_ERROR. De ahí el
  // cast al llamarlo: el tipo dice lo mismo que decía el `@Body()` de antes.
  mapping: z.record(z.string(), z.string()).optional(),
});

/** La supresión por solicitud del titular (SPEC §39). */
const SupresionDelTitular = z.object({
  // El motivo puede venir vacío: quien decide si la supresión procede es el
  // caso de uso, y lo dice con SUPRESION_RECHAZADA.
  motivo: z.string().optional(),
});

const DuplicadoAFusionar = z.object({
  duplicateId: textoRequerido('Indica el contacto duplicado que se fusiona en este.'),
});

const CorreccionDeContacto = z.object({
  // Nulables a propósito: mandar `null` BORRA y no mandar el campo lo deja
  // como estaba (#480). Un esquema que solo aceptara texto dejaría otra vez
  // sin forma de vaciar el correo, que es justo el bug que #480 arregló.
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  rut: z.string().nullable().optional(),
  ownerId: z.string().optional(),
  // El contenido de `custom` se valida DENTRO del caso de uso contra los
  // campos que declaró este negocio —tipo, obligatoriedad, opciones de
  // lista—; el esquema no sabe qué declaró cada uno.
  custom: z.record(z.string(), z.unknown()).optional(),
});

const NuevaActividad = z.object({
  // Primero el tipo y después el título: con los dos malos el mensaje que se
  // lee es el del tipo, como era con los dos `if` seguidos.
  type: z.enum(TIPOS, { error: 'La actividad es llamada, reunión, tarea o nota.' }),
  title: textoRequerido('La actividad necesita un título.'),
  body: z.string().optional(),
  // Se acepta lo que `new Date` entienda, igual que antes: la ficha manda ISO
  // y el agente manda AAAA-MM-DD. El mensaje va en el tipo Y en la
  // restricción: un `dueAt` que llegue como número falla el tipo, no el
  // refine, y ahí saldría el «Invalid input» de zod.
  dueAt: z
    .string({ error: 'Indica una fecha válida para la actividad.' })
    .refine(
      (v) => Number.isFinite(new Date(v).getTime()),
      'Indica una fecha válida para la actividad.',
    )
    .optional(),
  dealId: z.string().optional(),
});

/** La ficha de contacto (#32, SPEC §10/§29) y sus actividades. */
@ApiTags('crm')
@Controller('contacts')
@RequireModule('crm')
export class ContactsController {
  @Get()
  @RequirePermission('crm.contacts.read')
  @ApiOperation({ summary: 'Contactos con búsqueda y cursor' })
  @ApiQuery({ name: 'sort', required: false, enum: ['activity', 'name', 'phone', 'origin'] })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } })
  @ApiQuery({ name: 'q', required: false, type: String })
  async list(
    @Req() request: WithUser,
    @Query('q') q?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        listContacts(c, actor.tenantId, { q, sort, order, cursor, limit: limit ? Number(limit) : undefined }),
      );
    } catch (e) {
      if (e instanceof InvalidListQuery) throw new BadRequestException({ code: 'INVALID_LIST_QUERY', message: e.message });
      throw e;
    }
  }

  /**
   * La lista completa en CSV (issue 248). Es la contraparte de la
   * importación: quien trajo su lista tiene que poder llevársela, y en el
   * formato que va a abrir — una planilla, no un JSON.
   *
   * Los campos personalizados declarados salen como columnas propias.
   */
  @Get('exportar')
  @RequirePermission('crm.contacts.export')
  @ApiOperation({ summary: 'Exporta los contactos a CSV' })
  async exportar(@Req() request: WithUser, @Res({ passthrough: true }) res: Response) {
    const actor = actorOf(request);
    const { csv, filas } = await withTenant(pool(), actor.tenantId, (c) =>
      exportarContactos(c, { tenantId: actor.tenantId }),
    );
    const dia = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contactos-${dia}.csv"`);
    res.setHeader('X-Filas', String(filas));
    // El BOM hace que Excel en español abra los acentos bien. Sin él, la
    // primera columna llega con la ñ rota y el negocio cree que perdimos su
    // información.
    return `\uFEFF${csv}`;
  }

  /** Vista previa de importación (#34): valida fila por fila, NADA se escribe. */
  @Post('import/preview')
  @RequirePermission('crm.contacts.create')
  @ApiOperation({ summary: 'Vista previa del CSV: mapeo y validación fila a fila' })
  async importPreview(
    @Req() request: WithUser,
    @Cuerpo(ImportacionDeCsv) body: z.infer<typeof ImportacionDeCsv>,
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        previewImport(c, {
          tenantId: actor.tenantId,
          csv: body.csv,
          mapping: body.mapping as Record<number, ImportField> | undefined,
        }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'IMPORT_ERROR', message: (err as Error).message });
    }
  }

  @Post('import/confirm')
  @RequirePermission('crm.contacts.create')
  @ApiOperation({ summary: 'Confirma la importación: crea las filas válidas' })
  async importConfirm(
    @Req() request: WithUser,
    @Cuerpo(ImportacionDeCsv) body: z.infer<typeof ImportacionDeCsv>,
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        confirmImport(c, {
          tenantId: actor.tenantId,
          csv: body.csv,
          mapping: body.mapping as Record<number, ImportField> | undefined,
          actor: actor.userId,
          requestId: request.requestId,
        }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'IMPORT_ERROR', message: (err as Error).message });
    }
  }

  /** Fusión (#34): solo SUPERVISOR/ADMIN (crm.contacts.merge, §23). */
  @Get(':id/titular')
  @RequirePermission('crm.titular.manage')
  @ApiOperation({ summary: 'Todo lo que tenemos de esta persona, para entregárselo' })
  async exportarTitular(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        exportarTitular(c, {
          tenantId: actor.tenantId,
          contactId: id,
          actor: actor.userId,
          requestId: request.requestId,
        }),
      );
    } catch (err) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: (err as Error).message });
    }
  }

  @Post(':id/titular/suprimir')
  @RequirePermission('crm.titular.manage')
  @ApiOperation({ summary: 'Suprime los datos personales por solicitud del titular' })
  async suprimirTitular(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(SupresionDelTitular) body: z.infer<typeof SupresionDelTitular>,
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        suprimirTitular(c, {
          tenantId: actor.tenantId,
          contactId: id,
          actor: actor.userId,
          motivo: body.motivo ?? '',
          requestId: request.requestId,
        }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'SUPRESION_RECHAZADA', message: (err as Error).message });
    }
  }

  @Post(':id/merge')
  @RequirePermission('crm.contacts.merge')
  @ApiOperation({ summary: 'Fusiona un duplicado en este contacto' })
  async merge(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(DuplicadoAFusionar) body: z.infer<typeof DuplicadoAFusionar>,
  ) {
    const actor = actorOf(request);
    try {
      await withTenant(pool(), actor.tenantId, (c) =>
        mergeContacts(c, {
          tenantId: actor.tenantId,
          primaryId: id,
          duplicateId: body.duplicateId,
          actor: actor.userId,
          requestId: request.requestId,
        }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'MERGE_ERROR', message: (err as Error).message });
    }
    return { merged: true };
  }

  @Get(':id')
  @RequirePermission('crm.contacts.read')
  @ApiOperation({ summary: 'Ficha: contacto, oportunidades y actividades' })
  async ficha(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      getContactFicha(c, actor.tenantId, id),
    ).catch(() => {
      throw new NotFoundException({
        code: 'CONTACT_NOT_FOUND',
        message: 'No encontramos ese contacto. Puede que se haya eliminado.',
      });
    });
  }

  /**
   * Editar el contacto (#32, #34).
   *
   * Faltaba entero. `updateContact` existía en el contrato de `crm` y solo
   * la llamaba el webchat, para poner nombre y correo de quien escribe. Así
   * que los CAMPOS PROPIOS del negocio se podían declarar, validar y
   * guardar en el esquema — y no había forma de ponerles un valor. Un campo
   * que no se puede llenar no es un campo.
   *
   * `custom` se valida contra lo declarado dentro del caso de uso: tipo,
   * obligatoriedad y opciones de lista. Lo que el negocio ya tenía guardado
   * de antes sigue pasando, para que declarar un campo nuevo no rompa todas
   * las fichas viejas de golpe.
   */
  @Patch(':id')
  @RequirePermission('crm.contacts.update')
  @ApiOperation({ summary: 'Corrige el contacto y sus campos propios' })
  async actualizar(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(CorreccionDeContacto) body: z.infer<typeof CorreccionDeContacto>,
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        updateContact(c, {
          tenantId: actor.tenantId,
          contactId: id,
          // El esquema descarta lo que no declara, así que este `...body` ya
          // no puede traer un `tenantId` de otro negocio y pisar el de
          // arriba: antes era el orden del spread lo único que lo cuidaba.
          ...body,
          actor: actor.userId,
          requestId: request.requestId,
        }),
      );
    } catch (err) {
      const message = (err as Error).message;
      if (/No encontramos/.test(message)) {
        throw new NotFoundException({ code: 'CONTACT_NOT_FOUND', message });
      }
      // Lo que no calza con lo declarado: tipo, opción fuera de la lista,
      // obligatorio vacío. El mensaje del dominio ya explica cuál.
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message });
    }
  }

  @Post(':id/activities')
  @RequirePermission('crm.activities.manage')
  @ApiOperation({ summary: 'Crea una actividad (llamada, reunión, tarea, nota)' })
  async crear(
    @Req() request: WithUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Cuerpo(NuevaActividad) body: z.infer<typeof NuevaActividad>,
  ) {
    const actor = actorOf(request);
    // El `dealId` se queda con el pipe y NO pasa al esquema: su rechazo sale
    // con el código del pipe de Nest (BAD_REQUEST), no con VALIDATION_ERROR,
    // y pasarlo a zod cambiaría el código que ya reciben el SDK y el agente.
    if (body.dealId !== undefined) {
      await new ParseUUIDPipe().transform(body.dealId, { type: 'body', data: 'dealId' });
    }
    return withTenant(pool(), actor.tenantId, (c) =>
      createActivity(c, {
        tenantId: actor.tenantId,
        contactId: id,
        dealId: body.dealId,
        type: body.type,
        title: body.title,
        body: body.body,
        // La API key tiene identidad de servicio; no es un responsable humano.
        ownerId: actor.kind === 'apikey' ? undefined : actor.userId,
        actor: actor.userId,
        actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
        requestId: request.requestId,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        dueAt: body.dueAt ? new Date(body.dueAt) : undefined,
      }),
    ).catch((err: unknown) => {
      if (err instanceof ActivityReferenceError) {
        throw new NotFoundException({ code: err.code, message: err.message });
      }
      throw err;
    });
  }

  /**
   * Lo que hay que hacer, junto (#454).
   *
   * Las actividades se creaban —desde la ficha y desde el asistente— y la
   * única forma de verlas era abrir la ficha del contacto exacto. «¿Qué
   * tengo que hacer hoy?» no tenía respuesta en el producto.
   *
   * Va en el controlador de contactos y no en uno nuevo porque una
   * actividad no existe sin su contacto: es su ficha, vista de otro lado.
   */
  @Get('activities')
  @RequirePermission('crm.contacts.read')
  @ApiOperation({ summary: 'Actividades pendientes del negocio, lo vencido primero' })
  async actividades(
    @Req() request: WithUser,
    @Query('todas') todas?: string,
    @Query('incluirHechas') incluirHechas?: string,
  ) {
    const actor = actorOf(request);
    // Quien no puede ver lo del equipo ve lo SUYO, igual que el tablero de
    // oportunidades (ADR-0008: el permiso decide, no el rol).
    const soloMias = todas !== 'true' || !actorCan(actor, 'crm.read_all');
    return withTenant(pool(), actor.tenantId, (c) =>
      listActivities(c, {
        tenantId: actor.tenantId,
        ...(soloMias ? { ownerId: actor.userId } : {}),
        incluirHechas: incluirHechas === 'true',
      }),
    );
  }

  @Post('activities/:activityId/done')
  @RequirePermission('crm.activities.manage')
  @ApiOperation({ summary: 'Marca la actividad como hecha' })
  async listo(@Req() request: WithUser, @Param('activityId') activityId: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      completeActivity(c, { tenantId: actor.tenantId, activityId }),
    ).catch(() => {
      throw new NotFoundException({
        code: 'ACTIVITY_NOT_FOUND',
        message: 'No encontramos esa actividad.',
      });
    });
  }
}
