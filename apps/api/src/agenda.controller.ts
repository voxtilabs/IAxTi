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
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  agendar,
  cambiarEstadoCita,
  motivosDeCancelacion,
  citasDesincronizadasConGoogle,
  configuracionDeAvisos,
  definirDisponibilidad,
  listarDisponibilidad,
  quitarDisponibilidad,
  desdeHora,
  huecosDelDia,
  listarCitas,
  type EstadoCita,
} from '@iaxti/module-calendar';
import { getTenantSettings, updateTenantSettings } from '@iaxti/module-organizations';
import { listTemplates } from '@iaxti/module-whatsapp';
import { z } from 'zod';
import { RequireModule, RequirePermission } from './authz/decorators';
import { actorCan } from './authz/can';
import { Cuerpo, textoRequerido } from './validar';
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
  @RequirePermission('calendar.manage_availability')
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
  @RequirePermission('calendar.manage_availability')
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
    return withTenant(pool(), actor.tenantId, (c) =>
      listarDisponibilidad(c, { tenantId: actor.tenantId, ownerId: ownerId ?? actor.userId }),
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
    try {
      await withTenant(pool(), actor.tenantId, (c) =>
        quitarDisponibilidad(c, {
          tenantId: actor.tenantId,
          ownerId: ownerId ?? actor.userId,
          id,
        }),
      );
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
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        definirDisponibilidad(c, {
          tenantId: actor.tenantId,
          ownerId: body?.ownerId ?? actor.userId,
          weekday: Number(body?.weekday ?? 1),
          inicioMin: desdeHora(body?.inicio ?? '09:00'),
          finMin: desdeHora(body?.fin ?? '18:00'),
          duracion: body?.duracion,
          respiro: body?.respiro,
          anticipacionMin: body?.anticipacionMin,
        }),
      );
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
    return withTenant(pool(), actor.tenantId, (c) =>
      huecosDelDia(c, { tenantId: actor.tenantId, ownerId: ownerId ?? actor.userId, dia }),
    );
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
    return withTenant(pool(), actor.tenantId, (c) =>
      listarCitas(c, { tenantId: actor.tenantId, ownerId, desde: d, hasta: h }),
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
      return await withTenant(pool(), actor.tenantId, (c) =>
        agendar(c, {
          tenantId: actor.tenantId,
          contactId: body.contactId,
          ownerId: body.ownerId ?? actor.userId,
          // La fecha se sigue armando acá y no en el esquema: si viene una
          // hora que no se entiende, el que avisa es el módulo con su propio
          // mensaje, y ese texto ya está probado.
          inicio: new Date(body.inicio),
          fin: new Date(body.fin),
          title: body.title,
          conversationId: body.conversationId,
          confirmada: body.confirmada,
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
    // Sin `calendar.read_all` cada uno ve SOLO sus cancelaciones, igual que su
    // agenda. No hay un permiso aparte: el de la agenda ya decide eso.
    return withTenant(pool(), actor.tenantId, async (c) => ({
      ...(await motivosDeCancelacion(c, {
        tenantId: actor.tenantId,
        from: from ?? comoDia(hace90),
        to: to ?? comoDia(hoy),
        ownerId: actorCan(actor, 'crm.read_all') ? null : actor.userId,
      })),
      desincronizadas: await citasDesincronizadasConGoogle(c, actor.tenantId),
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
}
