import {
  BadRequestException,
  ConflictException,
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
import { almacenR2 } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import { z } from 'zod';
import {
  ActivityReferenceError,
  agregarContactoAMano,
  completeActivity,
  confirmImport,
  ContactoDuplicado,
  createActivity,
  exportarContactos,
  exportarTitular,
  getContactFicha,
  InvalidListQuery,
  listActivities,
  listContacts,
  mergeContacts,
  ORIGENES_DE_CONTACTO,
  PERMISOS_DE_FILTRO,
  previewImport,
  suprimirTitular,
  TelefonoInvalido,
  updateContact,
} from '@iaxti/module-crm';
import type { ActivityType, ImportField } from '@iaxti/module-crm';
import { exportarDatosDelTitular } from '@iaxti/module-conversations';
import { RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo, textoRequerido } from './validar';
import { actorCan } from './authz/can';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';
import { supresionEnModulos } from './supresion-titular';

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

/** La forma de un correo, igual que la de las invitaciones de equipo (#902). */
const CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * El contacto que se agrega a mano (#1395).
 *
 * El teléfono es lo único obligatorio — es con lo que el canal después lo va a
 * encontrar. La validación de E.164 de verdad la hace el caso de uso con
 * `normalizePhone`, que conoce el plan de numeración; el esquema solo asegura
 * que viene algo escrito. Sin correo no hay problema: quien solo deja su
 * número es el caso más común.
 */
const ContactoNuevo = z.object({
  phone: textoRequerido('Escribe el teléfono con código de país, como +56912345678.'),
  name: z
    .string({ error: 'El nombre va en texto.' })
    .trim()
    .max(120, 'El nombre no puede pasar de 120 caracteres; el resto se lo cuentas cuando te escriba.')
    .optional(),
  email: z
    .string({ error: 'Escribe un correo válido, como ana@ejemplo.cl.' })
    .trim()
    .toLowerCase()
    .regex(CORREO, 'Escribe un correo válido, como ana@ejemplo.cl.')
    .max(200, 'El correo no puede pasar de 200 caracteres.')
    .optional(),
});

/**
 * Los filtros de la lista llegan como `?filter[origen]=...` (#1395).
 *
 * Express 5 parsea el querystring con `simple`: `filter[origen]` entra como UNA
 * llave plana del objeto, no como `filter.origen` anidado. Se aceptan las dos
 * formas —la plana de este despliegue y la anidada que armaría un parser
 * `qs`— y cualquier otra cosa que empiece con «filter» se RECHAZA en vez de
 * ignorarse en silencio: un filtro que se cae sin aviso es la lista equivocada
 * con cara de correcta, que es justo lo que #546 cazó en auditoría.
 */
const CAMPOS_DE_FILTRO = ['origen', 'permiso'] as const;

function valorDeFiltro(valor: unknown, campo: string): string | undefined {
  if (valor === undefined || valor === '') return undefined;
  if (typeof valor !== 'string') {
    throw new InvalidListQuery(`El filtro «${campo}» va con un solo valor.`);
  }
  return valor;
}

function campoDesconocido(campo: string): InvalidListQuery {
  return new InvalidListQuery(
    `No conocemos el filtro «${campo}». Los que puedes usar son: ${CAMPOS_DE_FILTRO.join(' y ')}.`,
  );
}

function filtrosDeLista(query: Record<string, unknown>): { origen?: string; permiso?: string } {
  const filtros: { origen?: string; permiso?: string } = {};
  const conocidos = CAMPOS_DE_FILTRO as readonly string[];
  for (const [clave, valor] of Object.entries(query)) {
    if (clave === 'filter') {
      // Forma anidada (`filter.origen`): solo la produce un parser `qs`.
      if (valor === null || typeof valor !== 'object') throw campoDesconocido('filter');
      for (const [campo, anidado] of Object.entries(valor as Record<string, unknown>)) {
        if (!conocidos.includes(campo)) throw campoDesconocido(campo);
        const texto = valorDeFiltro(anidado, campo);
        if (texto !== undefined) filtros[campo as (typeof CAMPOS_DE_FILTRO)[number]] = texto;
      }
      continue;
    }
    const plano = /^filter\[([a-z_]+)\]$/.exec(clave);
    if (plano) {
      const campo = plano[1];
      if (!conocidos.includes(campo)) throw campoDesconocido(campo);
      const texto = valorDeFiltro(valor, campo);
      if (texto !== undefined) filtros[campo as (typeof CAMPOS_DE_FILTRO)[number]] = texto;
      continue;
    }
    if (clave.startsWith('filter')) {
      throw campoDesconocido(clave);
    }
  }
  return filtros;
}

/**
 * Un valor de query que viaja solo: texto, o nada si no vino.
 *
 * Un valor REPETIDO (`?q=a&q=b`) llega como arreglo, y ignorarlo en silencio
 * devolvería la lista completa con cara de haberla filtrado — el mismo defecto
 * de #546. Se rechaza: mejor un 400 que una respuesta que miente.
 */
function textoDeQuery(query: Record<string, unknown>, campo: string): string | undefined {
  const valor = query[campo];
  if (valor === undefined) return undefined;
  if (typeof valor !== 'string') {
    throw new InvalidListQuery(`El parámetro «${campo}» va con un solo valor.`);
  }
  return valor === '' ? undefined : valor;
}

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
  @ApiOperation({ summary: 'Contactos con búsqueda, filtros y cursor' })
  @ApiQuery({ name: 'sort', required: false, enum: ['activity', 'name', 'phone', 'origin'] })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({
    name: 'filter[origen]',
    required: false,
    enum: [...ORIGENES_DE_CONTACTO],
    description: 'Por dónde entró el contacto: manual, importado o algún canal.',
  })
  @ApiQuery({
    name: 'filter[permiso]',
    required: false,
    enum: [...PERMISOS_DE_FILTRO],
    description: 'Si el negocio le puede escribir primero: puede, sin_permiso o baja.',
  })
  async list(
    @Req() request: WithUser,
    @Query() query: Record<string, unknown>,
  ) {
    const actor = actorOf(request);
    try {
      // Dentro del try a propósito: un filtro o un parámetro mal escrito
      // también es un INVALID_LIST_QUERY, y si esto fuera afuera saldría
      // como 500.
      const filtros = filtrosDeLista(query);
      const limit = textoDeQuery(query, 'limit');
      return await withTenant(pool(), actor.tenantId, (c) =>
        listContacts(c, actor.tenantId, {
          q: textoDeQuery(query, 'q'),
          sort: textoDeQuery(query, 'sort'),
          order: textoDeQuery(query, 'order'),
          cursor: textoDeQuery(query, 'cursor'),
          limit: limit ? Number(limit) : undefined,
          origen: filtros.origen,
          permiso: filtros.permiso,
        }),
      );
    } catch (e) {
      if (e instanceof InvalidListQuery) throw new BadRequestException({ code: 'INVALID_LIST_QUERY', message: e.message });
      throw e;
    }
  }

  /**
   * Agregar un contacto a mano (#1395).
   *
   * El camino de siempre crea contactos cuando ALGUIEN ESCRIBE; este es para
   * la persona que está atendiendo y anota a un cliente que todavía no habló.
   * Nace con `origin: 'manual'` y SIN permiso para escribirle — escribirle
   * primero queda bloqueado hasta que él escriba o dé su opt-in (SPEC §8).
   *
   * Se llama `create` y no `crear` porque `crear` ya existe y crea una
   * ACTIVIDAD (`POST /contacts/:id/activities`): el operationId
   * `ContactsController_create` es el que el catálogo de la IA y el SDK
   * derivan, y repetirlo habría colado dos rutas con el mismo nombre.
   */
  @Post()
  @RequirePermission('crm.contacts.create')
  @ApiOperation({ summary: 'Agrega un contacto a mano (nace sin permiso para escribirle)' })
  async create(
    @Req() request: WithUser,
    @Cuerpo(ContactoNuevo) body: z.infer<typeof ContactoNuevo>,
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        agregarContactoAMano(c, {
          tenantId: actor.tenantId,
          phone: body.phone,
          name: body.name || undefined,
          email: body.email || undefined,
          actor: actor.userId,
          // La API key tiene identidad de servicio; en el libro de auditoría
          // no puede figurar como una persona.
          actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
          requestId: request.requestId,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        }),
      );
    } catch (err) {
      // El teléfono ya estaba: 409 y el id del existente, para que la
      // interfaz ofrezca ABRIR esa ficha en vez de insistir con crear otra.
      if (err instanceof ContactoDuplicado) {
        throw new ConflictException({
          code: 'CONTACT_EXISTS',
          message: err.message,
          details: [{ contactId: err.contactId }],
        });
      }
      // El caso de uso tradujo el rechazo de `normalizePhone`; el campo va en
      // los details para que la pantalla ponga el foco donde corresponde.
      if (err instanceof TelefonoInvalido) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: err.message,
          details: [{ field: 'phone', message: err.message }],
        });
      }
      throw err;
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

  /**
   * La misma lista, en una planilla de verdad (#709).
   *
   * El CSV de arriba SE QUEDA: quien lo necesita para importar a otro sistema lo
   * sigue teniendo. Esto es para quien la va a abrir y mirar, que es casi
   * siempre — y ahí el CSV falla por dos cosas que el BOM no arregla: Excel con
   * configuración de Chile espera punto y coma, así que todo llega en una
   * columna; y no tiene tipos, así que `+56981234567` se abre como 5,6981E+10.
   */
  @Get('exportar.xlsx')
  @RequirePermission('crm.contacts.export')
  @ApiOperation({ summary: 'Exporta los contactos a una planilla de Excel' })
  async exportarXlsx(@Req() request: WithUser, @Res() res: Response) {
    const actor = actorOf(request);
    const { xlsx, filas } = await withTenant(pool(), actor.tenantId, (c) =>
      exportarContactos(c, { tenantId: actor.tenantId }),
    );
    const dia = new Date().toISOString().slice(0, 10);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="contactos-${dia}.xlsx"`);
    res.setHeader('X-Filas', String(filas));
    // Sin `passthrough`: un Buffer que pasa por el serializador de Nest sale
    // como JSON y el archivo llega corrupto.
    res.end(xlsx);
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
          leerConversaciones: exportarDatosDelTitular,
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
          // Explícito y no ambiental: una supresión legal que se comporta
          // distinto según qué variables haya en el proceso no se puede declarar
          // cumplida. Quien sabe si este ambiente tiene almacén es el
          // controlador.
          almacen: almacenR2(),
          modulos: supresionEnModulos,
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
  // OJO CON EL ORDEN (#657): esto va ANTES de `@Get(':id')`, y no es estilo.
  //
  // NestJS resuelve las rutas en ORDEN DE DECLARACIÓN. Con `:id` declarado
  // primero, `GET /contacts/activities` entraba por la ficha con
  // `id = 'activities'`, no encontraba nada, y el `catch` lo convertía en un 404
  // `CONTACT_NOT_FOUND`. La pantalla de Pendientes mostraba su estado vacío —o
  // sea, decía que estabas al día— y nunca pudo mostrar una sola actividad.
  //
  // Toda ruta LITERAL de este controlador va arriba de la que lleva parámetro.
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
      // El caso de uso rechaza el cambio con su propio código cuando dejaría
      // al contacto sin NINGUNA forma de reconocerlo. Se lee del error y no
      // del texto del mensaje: la interfaz necesita distinguir este rechazo
      // —tiene otra salida que ofrecer— de un dato mal escrito.
      if ((err as { code?: unknown }).code === 'ULTIMO_IDENTIFICADOR') {
        throw new BadRequestException({ code: 'ULTIMO_IDENTIFICADOR', message });
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
