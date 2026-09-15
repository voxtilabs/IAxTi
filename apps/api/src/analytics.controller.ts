import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import { getDashboard, esDia, ultimosDias, TZ_POR_DEFECTO } from '@iaxti/module-analytics';
import { RequireModule, RequirePermission } from './authz/decorators';
import { actorCan } from './authz/can';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

// analytics (#66, SPEC §19): el dueño ve cómo va el negocio sin armar un
// reporte. Sin read_all, cada uno ve SOLO sus números (matriz §23).

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

const MAX_RANGO_DIAS = 366;

@ApiTags('analytics')
@Controller('analytics')
@RequireModule('analytics')
export class AnalyticsController {
  @Get('dashboard')
  @RequirePermission('analytics.read')
  @ApiOperation({ summary: 'Las métricas del rango — cada número con su definición' })
  async dashboard(
    @Req() request: WithUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('ownerId') ownerId?: string,
  ) {
    const actor = actorOf(request);
    // Los días viajan como texto AAAA-MM-DD en la zona del negocio: mandar
    // un Date hace que Postgres lo convierta y el rango se corra un día
    // entero (en Chile, cada noche a partir de las 21:00).
    // Mediodía UTC como ancla al calcular desde un `to` dado: así ninguna
    // zona horaria corre el día al restar.
    const ancla = to && esDia(to) ? new Date(`${to}T12:00:00Z`) : new Date();
    const pordefecto = ultimosDias(30, TZ_POR_DEFECTO, ancla);
    const hasta = to ?? pordefecto.to;
    const desde = from ?? pordefecto.from;
    if (!esDia(desde) || !esDia(hasta) || desde > hasta) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'El rango de fechas no se entiende (from y to como AAAA-MM-DD).',
      });
    }
    const dias = (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000;
    if (dias > MAX_RANGO_DIAS) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'El rango máximo es un año.',
      });
    }
    // Sin read_all se ven SOLO los números propios (verificación en el
    // caso de uso, ADR-0008) — pedir los de un colega también exige read_all.
    const verTodo = actorCan(actor, 'analytics.read_all');
    const dueño = verTodo ? (ownerId ?? null) : actor.userId;
    return withTenant(pool(), actor.tenantId, (c) =>
      getDashboard(c, { tenantId: actor.tenantId, from: desde, to: hasta, ownerId: dueño }),
    );
  }
}
