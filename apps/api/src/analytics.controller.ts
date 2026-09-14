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
import { getDashboard } from '@iaxti/module-analytics';
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
    const hasta = to ? new Date(to) : new Date();
    const desde = from ? new Date(from) : new Date(hasta.getTime() - 29 * 86_400_000);
    if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime()) || desde > hasta) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'El rango de fechas no se entiende (from y to como AAAA-MM-DD).',
      });
    }
    if (hasta.getTime() - desde.getTime() > MAX_RANGO_DIAS * 86_400_000) {
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
