import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  ForbiddenException,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import { roleOf } from '@iaxti/module-identity';
import { writeAudit } from '@iaxti/module-audit';
import {
  agendar,
  cambiarEstadoCita,
  reagendarCita,
  motivosDeCancelacion,
  citasDesincronizadasConGoogle,
  configuracionDeAvisos,
  definirDisponibilidad,
  listarDisponibilidad,
  quitarDisponibilidad,
  cerrarDias,
  listarCierres,
  abrirDias,
  cierrePorId,
  citasDentroDelCierre,
  desdeHora,
  huecosConGoogle,
  listarCitas,
  type EstadoCita,
} from '@iaxti/module-calendar';
import { conversacionParaIniciar } from '@iaxti/module-conversations';
import { getTenantSettings, updateTenantSettings, zonaDelTenant } from '@iaxti/module-organizations';
import { listTemplates } from '@iaxti/module-whatsapp';
import { z } from 'zod';
import { RequireModule, RequirePermission } from './authz/decorators';
import { permisosDelActor } from './authz/can';
import { Cuerpo, textoRequerido, idRequerido, validar } from './validar';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

/**
 * La agenda (SPEC §16): agendar desde el chat con horarios reales.
 *
 * Todo lo que tiene hora se calcula en la zona del NEGOCIO. Para una pyme de
 * Arica y otra de Punta Arenas "las 9" es la misma hora en la pantalla y dos
 * instantes distintos en la base.
 */
function pool() {
  const p = apiPool();
  if (!p) throw new BadRequestException({ code: 'DB_NOT_CONFIGURED', message: 'Sin base de datos.' });
  return p;
}

function actorOf(request: WithUser): Actor {
  return request.actor as Actor;
}

async function ownerDeAgenda(actor: Actor, requested?: string): Promise<string> {
  const ownerId = validar(idRequerido('La persona elegida no es válida.'),requested ?? actor.userId);
  if (ownerId !== actor.userId) {
    const permisos = await withTenant(pool(),actor.tenantId,c=>permisosDelActor(c,actor));
    if (!permisos.has('calendar.manage_team')) throw new ForbiddenException({
      code:'PERMISSION_DENIED',message:'Solo puedes consultar y cambiar tu propia disponibilidad.' });
    const member = await withTenant(pool(),actor.tenantId,c=>roleOf(c,actor.tenantId,ownerId));
    if (!member) throw new NotFoundException({code:'CALENDAR_OWNER_NOT_FOUND',message:'Esa persona no pertenece a este negocio.'});
  }
  return ownerId;
}

function seVeMal(err: unknown): never {
  throw new BadRequestException({ code: 'VALIDATION_ERROR', message: (err as Error).message });
}

/**
 * El cuerpo de agendar (#524).
 *
 * El mismo mensaje en los tres campos, y a propósito: la pantalla los manda
 * juntos, así que a quien está dando la hora no le sirve saber cuál de los
 * tres falta. Va copiado tal cual estaba en el `if` que reemplaza, porque es
 * el texto que lee alguien con el cliente esperando en el chat.
 */
const FALTA_LO_MINIMO = 'La cita necesita contacto, inicio y fin.';

const NuevaCita = z.object({
  contactId: textoRequerido(FALTA_LO_MINIMO),
  inicio: textoRequerido(FALTA_LO_MINIMO),
  fin: textoRequerido(FALTA_LO_MINIMO),
  ownerId: z.string().optional(),
  title: z.string().optional(),
  conversationId: z.string().optional(),
  confirmada: z.boolean().optional(),
});

/**
 * Cerrar días: feriados, vacaciones, el día que no se abre (#1281).
 *
 * `hasta` ausente cierra UN día. Y `todoElNegocio` es un campo aparte y
 * explícito a propósito: si el cierre del negocio completo fuera lo que pasa
 * al omitir `ownerId`, cerrar la pyme entera sería un descuido de un campo.
 * Por omisión se cierra la agenda de quien lo pide.
 */
const UN_DIA = 'Dinos qué día cierras, en formato 2026-09-18.';

const CerrarDias = z.object({
  desde: textoRequerido(UN_DIA).regex(/^\d{4}-\d{2}-\d{2}$/, UN_DIA),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, UN_DIA).optional(),
  motivo: z.string().optional(),
  ownerId: z.string().optional(),
  todoElNegocio: z.boolean().optional(),
});

/** Mover una cita (#836): a qué hora queda, y por qué si alguien lo escribió. */
const MOVER_SIN_HORA = 'Dinos a qué hora queda la cita: inicio y fin.';

const MoverLaCita = z.object({
  inicio: textoRequerido(MOVER_SIN_HORA),
  fin: textoRequerido(MOVER_SIN_HORA),
  motivo: z.string().optional(),
});

@ApiTags('calendar')
@Controller('agenda')
@RequireModule('calendar')
export class AgendaController {
  /**
   * Los horarios que atiende una persona del equipo. Sin esto la agenda no
   * ofrece nada: la disponibilidad es lo que el negocio configura, y el
   * calendario real de Google se cruza encima cuando esa conexión exista.
   */
  /**
   * Con qué plantilla sale cada recordatorio (#59).
   *
   * Vive en la agenda y no en la pantalla de plantillas porque es una
   * decisión de la AGENDA —qué se le avisa a quien tiene hora—, y porque
   * así sigue existiendo cuando el negocio todavía no tiene WhatsApp: lo
   * que falta se dice acá, en vez de que la sección no aparezca.
   */
  @Get('recordatorios')
  @RequirePermission('tenant.settings')
  @ApiOperation({ summary: 'Qué plantilla sale como recordatorio de cita' })
  async recordatorios(@Req() request: WithUser) {
    const actor = request.actor as Actor;
    return withTenant(pool(), actor.tenantId, async (c) => {
      const cfg = configuracionDeAvisos(await getTenantSettings(c, actor.tenantId));
      // Solo las APROBADAS se pueden elegir: una pendiente elegida hoy es un
      // recordatorio que no sale mañana y nadie sabe por qué.
      const plantillas = (await listTemplates(c, actor.tenantId))
        .filter((p) => p.status === 'approved')
        .map((p) => ({ id: p.id, name: p.name, variables: p.variables, body: p.body }));
      // `recordatorios` es lo ELEGIDO y `plantillas` lo ELEGIBLE. Estaban
      // los dos bajo el mismo nombre y la pantalla tenía que adivinar cuál
      // venía: dos cosas distintas con un nombre son un error esperando.
      return { recordatorios: cfg.plantillas, zona: cfg.zona, activo: cfg.activo, plantillas };
    });
  }

  @Put('recordatorios')
  @RequirePermission('tenant.settings')
  @ApiOperation({ summary: 'Elige la plantilla de cada recordatorio (o la quita)' })
  async guardarRecordatorios(
    @Req() request: WithUser,
    @Body() body: { '24h'?: string | null; '2h'?: string | null; zona?: string },
  ) {
    const actor = request.actor as Actor;
    return withTenant(pool(), actor.tenantId, async (c) => {
      const aprobadas = new Set(
        (await listTemplates(c, actor.tenantId)).filter((p) => p.status === 'approved').map((p) => p.id),
      );
      const elegida = (valor: string | null | undefined): string | null => {
        const id = typeof valor === 'string' && valor.trim() ? valor.trim() : null;
        if (id && !aprobadas.has(id)) {
          throw new BadRequestException({
            code: 'PLANTILLA_NO_APROBADA',
            message:
              'Esa plantilla no está aprobada. Un recordatorio con una plantilla pendiente no sale, ' +
              'y el cliente no se entera de que no salió.',
          });
        }
        return id;
      };
      const actuales = await getTenantSettings(c, actor.tenantId);
      const calendar = (actuales.calendar ?? {}) as Record<string, unknown>;
      await updateTenantSettings(c, actor.tenantId, {
        calendar: {
          ...calendar,
          recordatorios: { '24h': elegida(body?.['24h']), '2h': elegida(body?.['2h']) },
          ...(body?.zona ? { zona: body.zona } : {}),
        },
      });
      const cfg = configuracionDeAvisos(await getTenantSettings(c, actor.tenantId));
      return { recordatorios: cfg.plantillas, zona: cfg.zona, activo: cfg.activo };
    });
  }

  /**
   * Los horarios que ya están definidos (#460). Sin esta lectura la
   * pantalla de horarios no podía existir: se podían DEFINIR y no se
   * podían ver, así que cada visita agregaba una franja más sobre las
   * que ya estaban.
   */
  @Get('disponibilidad')
  @RequirePermission('calendar.read')
  @ApiOperation({ summary: 'Los horarios de atención de alguien del equipo' })
  async verDisponibilidad(@Req() request: WithUser, @Query('ownerId') ownerId?: string) {
    const actor = actorOf(request);
    const owner = await ownerDeAgenda(actor,ownerId);
    return withTenant(pool(), actor.tenantId, (c) =>
      listarDisponibilidad(c, { tenantId: actor.tenantId, ownerId: owner }),
    );
  }

  @Delete('disponibilidad/:id')
  @RequirePermission('calendar.manage_availability')
  @ApiOperation({ summary: 'Quita una franja horaria' })
  async borrarDisponibilidad(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Query('ownerId') ownerId?: string,
  ) {
    const actor = actorOf(request);
    const owner = await ownerDeAgenda(actor,ownerId);
    try {
      await withTenant(pool(), actor.tenantId, async (c) => {
        await quitarDisponibilidad(c, {
          tenantId: actor.tenantId,
          ownerId: owner,
          id,
        });
        await writeAudit(c,{tenantId:actor.tenantId,actor:actor.userId,actorKind:actor.kind==='apikey'?'apikey':'user',
          action:'calendar.availability.deleted',resource:'availability',resourceId:id,result:'ok',requestId:request.requestId,metadata:{ownerId:owner}});
      });
      // Las citas ya tomadas no se tocan: siguen en la agenda y hay que
      // avisarles a mano. Borrar el horario no las cancela.
      return { ok: true };
    } catch (err) {
      seVeMal(err);
    }
  }

  @Post('disponibilidad')
  @RequirePermission('calendar.manage_availability')
  @ApiOperation({ summary: 'Define los horarios que atiende alguien del equipo' })
  async disponibilidad(
    @Req() request: WithUser,
    @Body()
    body: {
      ownerId?: string;
      weekday?: number;
      inicio?: string;
      fin?: string;
      duracion?: number;
      respiro?: number;
      anticipacionMin?: number;
    },
  ) {
    const actor = actorOf(request);
    const owner = await ownerDeAgenda(actor,body?.ownerId);
    try {
      return await withTenant(pool(), actor.tenantId, async (c) => {
        const result = await definirDisponibilidad(c, {
          tenantId: actor.tenantId,
          ownerId: owner,
          weekday: Number(body?.weekday ?? 1),
          inicioMin: desdeHora(body?.inicio ?? '09:00'),
          finMin: desdeHora(body?.fin ?? '18:00'),
          duracion: body?.duracion,
          respiro: body?.respiro,
          anticipacionMin: body?.anticipacionMin,
        });
        await writeAudit(c,{tenantId:actor.tenantId,actor:actor.userId,actorKind:actor.kind==='apikey'?'apikey':'user',
          action:'calendar.availability.created',resource:'availability',resourceId:result.id,result:'ok',requestId:request.requestId,metadata:{ownerId:owner}});
        return result;
      });
    } catch (err) {
      seVeMal(err);
    }
  }

  @Get('huecos')
  @RequirePermission('calendar.read')
  @ApiOperation({ summary: 'Horarios libres de un día, en la hora del negocio' })
  async huecos(
    @Req() request: WithUser,
    @Query('dia') dia?: string,
    @Query('ownerId') ownerId?: string,
  ) {
    const actor = actorOf(request);
    if (!dia || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'El día va como AAAA-MM-DD.',
      });
    }
    const owner = await ownerDeAgenda(actor,ownerId);
    return huecosConGoogle(pool(), { tenantId: actor.tenantId, ownerId: owner, dia, actorId: actor.userId });
  }

  @Get()
  @RequirePermission('calendar.read')
  @ApiOperation({ summary: 'Citas entre dos fechas' })
  async listar(
    @Req() request: WithUser,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('ownerId') ownerId?: string,
  ) {
    const actor = actorOf(request);
    const d = desde ? new Date(desde) : new Date();
    const h = hasta ? new Date(hasta) : new Date(d.getTime() + 7 * 24 * 3600_000);
    if (Number.isNaN(d.getTime()) || Number.isNaN(h.getTime())) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Las fechas no se entienden.' });
    }
    const permisos = await withTenant(pool(),actor.tenantId,c=>permisosDelActor(c,actor));
    const owner = ownerId ? await ownerDeAgenda(actor,ownerId)
      : permisos.has('calendar.manage_team') ? undefined : actor.userId;
    return withTenant(pool(), actor.tenantId, (c) =>
      listarCitas(c, { tenantId: actor.tenantId, ownerId: owner, desde: d, hasta: h }),
    );
  }

  @Post()
  @RequirePermission('calendar.book')
  @ApiOperation({ summary: 'Agenda una cita' })
  async agendar(
    @Req() request: WithUser,
    @Cuerpo(NuevaCita) body: z.infer<typeof NuevaCita>,
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, async (c) => {
        /**
         * La conversación por donde avisarle, resuelta acá (#1249).
         *
         * Una cita sin `conversation_id` no puede recibir recordatorio: el
         * envío muere en el worker con «la cita no tiene conversación por
         * dónde avisar» y, peor, el aviso ya quedó consumido, así que tampoco
         * se reintenta. La pantalla «Dar una hora» nunca mandó ese campo, así
         * que TODA cita creada desde la interfaz nacía sin recordatorio.
         *
         * Se resuelve en el controller y no dentro de `calendar` a propósito:
         * `calendar` no declara `conversations` en su `depends_on` y meterle
         * esa dependencia para una línea sería acoplar dos módulos por la
         * puerta de atrás. El controller es el lugar donde orquestar dos
         * contratos es legítimo (regla de arquitectura), y
         * `conversacionParaIniciar` recibe NUESTRO cliente, así que entra en
         * la misma transacción que la cita.
         *
         * Degrada y no rompe: un contacto sin canal todavía puede recibir una
         * hora —se la dieron por teléfono—, simplemente no habrá recordatorio.
         * Eso se ve después en la fila (#1250), no se esconde.
         */
        let conversationId = body.conversationId;
        if (!conversationId) {
          try {
            const r = await conversacionParaIniciar(c, {
              tenantId: actor.tenantId,
              contactId: body.contactId,
            });
            conversationId = r.conversationId;
          } catch (err) {
            console.warn(
              `[${(request as { requestId?: string }).requestId}] agenda: la cita de ${body.contactId} ` +
                `se crea SIN conversación, así que no tendrá recordatorio — ${(err as Error).message}`,
            );
          }
        }
        return agendar(c, {
          tenantId: actor.tenantId,
          contactId: body.contactId,
          ownerId: body.ownerId ?? actor.userId,
          // La fecha se sigue armando acá y no en el esquema: si viene una
          // hora que no se entiende, el que avisa es el módulo con su propio
          // mensaje, y ese texto ya está probado.
          inicio: new Date(body.inicio),
          fin: new Date(body.fin),
          title: body.title,
          conversationId,
          /**
           * Por omisión, CONFIRMADA (#1249).
           *
           * `proposed` existe para la hora que alguien pidió y nadie aceptó
           * todavía. Cuando una persona del negocio entra a «Dar una hora» y
           * la da, el visto bueno humano YA ocurrió: dejarla en `proposed`
           * obligaba a un segundo clic en otra pantalla y, mientras tanto, la
           * cita quedaba fuera del barrido de recordatorios —que solo mira
           * `confirmed` y `reminded`— para siempre si nadie volvía.
           *
           * Quien quiera una propuesta la pide explícitamente con
           * `confirmada: false`. El defecto cambia; la posibilidad no se
           * pierde.
           */
          confirmada: body.confirmada ?? true,
          actor: actor.userId,
          actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
          requestId: (request as { requestId?: string }).requestId,
        });
      });
    } catch (err) {
      seVeMal(err);
    }
  }

  /**
   * Por qué se nos cancelan las visitas (#700).
   *
   * `cancel_reason` se escribía en cada cancelación desde el primer día y
   * ninguna consulta lo devolvía. Para un negocio con cinco visitas al día es
   * la pregunta del mes, y se contestaba abriendo la base.
   *
   * Viene también la lista de las que quedaron canceladas acá y vivas en
   * Google: una cita así ocupa una hora que el vendedor ve libre.
   */
  @Get('cancelaciones')
  @RequirePermission('calendar.read')
  @ApiOperation({ summary: 'Los motivos de cancelación del período, agrupados' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'AAAA-MM-DD' })
  @ApiQuery({ name: 'to', required: false, type: String })
  async cancelaciones(
    @Req() request: WithUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const actor = actorOf(request);
    const dia = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !dia.test(from)) || (to && !dia.test(to))) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'El rango de fechas no se entiende (from y to como AAAA-MM-DD).',
      });
    }
    // Por defecto, los últimos 90 días: un mes solo no alcanza para que un
    // motivo se repita lo suficiente como para significar algo.
    const hoy = new Date();
    const hace90 = new Date(hoy.getTime() - 90 * 86_400_000);
    const comoDia = (d: Date) => d.toISOString().slice(0, 10);
    const permisos = await withTenant(pool(),actor.tenantId,c=>permisosDelActor(c,actor));
    const owner = permisos.has('calendar.manage_team') ? null : actor.userId;
    return withTenant(pool(), actor.tenantId, async (c) => ({
      ...(await motivosDeCancelacion(c, {
        tenantId: actor.tenantId,
        from: from ?? comoDia(hace90),
        to: to ?? comoDia(hoy),
        ownerId: owner,
      })),
      desincronizadas: await citasDesincronizadasConGoogle(c, actor.tenantId, owner),
    }));
  }

  /**
   * Confirmar, marcar asistida, marcar que no llegó o cancelar. El no-show
   * publica su evento: es de los flujos que más plata recuperan si hay una
   * regla escuchándolo.
   */
  @Post(':id/estado')
  @RequirePermission('calendar.book')
  @ApiOperation({ summary: 'Confirma, marca asistida o no-show, o cancela' })
  async estado(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Body() body: { estado?: string; motivo?: string },
  ) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        cambiarEstadoCita(c, {
          tenantId: actor.tenantId,
          appointmentId: id,
          to: (body?.estado ?? '') as EstadoCita,
          motivo: body?.motivo,
          actor: actor.userId,
          actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
          requestId: (request as { requestId?: string }).requestId,
        }),
      );
    } catch (err) {
      seVeMal(err);
    }
  }

  /**
   * Mover una cita de hora (#836).
   *
   * Es su propia ruta y no un `estado`, porque no es un cambio de estado:
   * `rescheduled` como estado terminal dejaba la cita congelada y la hora
   * liberada acá mientras seguía tomada en Google (#837 cerró esa puerta).
   * Mover es otra operación, y la cita sigue siendo la misma.
   *
   * `calendar.book` y no un permiso nuevo: quien puede tomar una hora puede
   * correrla. Inventar `calendar.reschedule` obligaría a cada negocio a
   * repartir un permiso más para algo que ya estaba permitido.
   */
  @Post(':id/mover')
  @RequirePermission('calendar.book')
  @ApiOperation({
    summary: 'Mueve una cita a otra hora; por llave de API, contra el horario publicado',
  })
  async mover(
    @Req() request: WithUser,
    @Param('id') id: string,
    @Cuerpo(MoverLaCita) body: z.infer<typeof MoverLaCita>,
  ) {
    const actor = actorOf(request);
    // Las fechas se convierten acá y el caso de uso rechaza las que no se
    // entienden, con su mensaje. Un `VALIDATION_ERROR` a mano sería una
    // segunda puerta diciendo lo mismo con otras palabras (#524).
    const inicio = new Date(body.inicio);
    const fin = new Date(body.fin);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        reagendarCita(c, {
          tenantId: actor.tenantId,
          appointmentId: id,
          inicio,
          fin,
          motivo: body?.motivo,
          // El criterio del ADR-0029, tal cual: una persona del equipo puede
          // mover una hora fuera del horario publicado —se quedó atendiendo,
          // le hizo un favor a alguien— y eso es legítimo. Un programa no
          // tiene cómo saber que es legítimo, así que para él la
          // disponibilidad es la frontera.
          //
          // Hasta la #1251 esta ruta prometía en su propia descripción «con su
          // hueco comprobado» y no comprobaba nada: el único control era que
          // no chocara con otra cita, así que una llave de API podía dejar una
          // hora a las tres de la mañana de un domingo.
          exigirHuecoDisponible: actor.kind === 'apikey',
          actor: actor.userId,
          actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
          requestId: (request as { requestId?: string }).requestId,
        }),
      );
    } catch (err) {
      seVeMal(err);
    }
  }

  /**
   * Cerrar días (#1281).
   *
   * La respuesta trae las citas que quedan dentro del cierre, y no las toca:
   * cerrar una semana con cinco personas confirmadas es un aviso al dueño, no
   * una cancelación masiva que le llega al cliente sin que nadie la haya
   * decidido. La pantalla muestra cuántas son y una persona resuelve.
   */
  @Post('cierres')
  @RequirePermission('calendar.manage_availability')
  @ApiOperation({ summary: 'Cierra un día o un rango: feriado, vacaciones, el día que no se abre' })
  async cerrar(@Req() request: WithUser, @Cuerpo(CerrarDias) body: z.infer<typeof CerrarDias>) {
    const actor = actorOf(request);
    // Cerrar el negocio completo afecta a todo el equipo, así que pide lo
    // mismo que tocar la agenda de otra persona.
    const owner = body.todoElNegocio ? null : await ownerDeAgenda(actor, body.ownerId);
    if (body.todoElNegocio) {
      const permisos = await withTenant(pool(), actor.tenantId, (c) => permisosDelActor(c, actor));
      if (!permisos.has('calendar.manage_team')) {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message: 'Cerrar el negocio completo lo hace quien administra el equipo.',
        });
      }
    }
    try {
      return await withTenant(pool(), actor.tenantId, async (c) => {
        const cierre = await cerrarDias(c, {
          tenantId: actor.tenantId,
          ownerId: owner,
          desde: body.desde,
          hasta: body.hasta,
          motivo: body.motivo,
          actor: actor.userId,
          actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
          requestId: (request as { requestId?: string }).requestId,
        });
        const citasAfectadas = await citasDentroDelCierre(c, {
          tenantId: actor.tenantId,
          ownerId: cierre.ownerId,
          desde: cierre.desde,
          hasta: cierre.hasta,
          zona: await zonaDelTenant(c, actor.tenantId),
        });
        return { cierre, citasAfectadas };
      });
    } catch (err) {
      seVeMal(err);
    }
  }

  @Get('cierres')
  @RequirePermission('calendar.manage_availability')
  @ApiQuery({ name: 'ownerId', required: false })
  @ApiQuery({
    name: 'incluirPasados',
    required: false,
    description: 'Por omisión solo salen los cierres que vienen, con el día de hoy en la zona del negocio',
  })
  @ApiOperation({ summary: 'Los días cerrados de alguien del equipo y los del negocio' })
  async cierres(
    @Req() request: WithUser,
    @Query('ownerId') ownerId?: string,
    @Query('incluirPasados') incluirPasados?: string,
  ) {
    const actor = actorOf(request);
    const owner = await ownerDeAgenda(actor, ownerId);
    return withTenant(pool(), actor.tenantId, (c) =>
      listarCierres(c, {
        tenantId: actor.tenantId,
        ownerId: owner,
        incluirPasados: incluirPasados === 'true',
      }),
    );
  }

  @Delete('cierres/:id')
  @RequirePermission('calendar.manage_availability')
  @ApiOperation({ summary: 'Reabre un día cerrado' })
  async reabrir(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    const cierre = await withTenant(pool(), actor.tenantId, (c) =>
      cierrePorId(c, { tenantId: actor.tenantId, cierreId: id }),
    );
    if (!cierre) {
      throw new NotFoundException({
        code: 'CALENDAR_TIME_OFF_NOT_FOUND',
        message: 'Ese cierre no existe en este negocio.',
      });
    }
    // Reabrir lo que cerró otra persona —o lo que cerró el negocio— pide el
    // mismo permiso que haberlo cerrado.
    if (cierre.ownerId !== actor.userId) {
      const permisos = await withTenant(pool(), actor.tenantId, (c) => permisosDelActor(c, actor));
      if (!permisos.has('calendar.manage_team')) {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message: 'Solo puedes reabrir los días que cerraste tú.',
        });
      }
    }
    await withTenant(pool(), actor.tenantId, (c) =>
      abrirDias(c, {
        tenantId: actor.tenantId,
        cierreId: id,
        actor: actor.userId,
        actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
        requestId: (request as { requestId?: string }).requestId,
      }),
    );
    return { ok: true };
  }
}
