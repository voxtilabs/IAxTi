import {
  BadRequestException,
  Body,
  Controller,
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
  agendar,
  cambiarEstadoCita,
  configuracionDeAvisos,
  definirDisponibilidad,
  desdeHora,
  huecosDelDia,
  listarCitas,
  type EstadoCita,
} from '@iaxti/module-calendar';
import { getTenantSettings, updateTenantSettings } from '@iaxti/module-organizations';
import { listTemplates } from '@iaxti/module-whatsapp';
import { RequireModule, RequirePermission } from './authz/decorators';
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
    @Body()
    body: {
      contactId?: string;
      ownerId?: string;
      inicio?: string;
      fin?: string;
      title?: string;
      conversationId?: string;
      confirmada?: boolean;
    },
  ) {
    const actor = actorOf(request);
    if (!body?.contactId || !body?.inicio || !body?.fin) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'La cita necesita contacto, inicio y fin.',
      });
    }
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        agendar(c, {
          tenantId: actor.tenantId,
          contactId: body.contactId!,
          ownerId: body?.ownerId ?? actor.userId,
          inicio: new Date(body.inicio!),
          fin: new Date(body.fin!),
          title: body?.title,
          conversationId: body?.conversationId,
          confirmada: body?.confirmada,
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
