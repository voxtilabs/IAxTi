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
import { getDashboard, esDia, ultimosDias } from '@iaxti/module-analytics';
import { zonaDelTenant } from '@iaxti/module-organizations';
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
    @Query('dias') diasPedidos?: string,
  ) {
    const actor = actorOf(request);
    // Los días viajan como texto AAAA-MM-DD en la zona del negocio: mandar
    // un Date hace que Postgres lo convierta y el rango se corra un día
    // entero (en Chile, cada noche a partir de las 21:00).
    // Mediodía UTC como ancla al calcular desde un `to` dado: así ninguna
    // zona horaria corre el día al restar.
    const ancla = to && esDia(to) ? new Date(`${to}T12:00:00Z`) : new Date();
    // Zona y métricas pertenecen a la misma lectura del negocio (#424).
    // Evita otra conexión y otro BEGIN/set_config/COMMIT para la zona.
    return withTenant(pool(), actor.tenantId, async (c) => {
      const zona = await zonaDelTenant(c, actor.tenantId);
      // `dias` existe porque el NAVEGADOR no conoce la zona del negocio
      // (#1074). Antes armaba el rango él, con `toISOString()`, y mandaba
      // un `from`/`to` en UTC: entre las 21:00 y la medianoche chilenas el
      // panel perdía el día más viejo de la ventana y pedía uno que todavía
      // no existe, con la comparación contra el período anterior corrida
      // junto con él. El servidor sí conoce la zona, así que el rango se
      // resuelve acá y la respuesta dice cuál usó.
      const cuantos = diasPedidos === undefined ? null : Number(diasPedidos);
      if (cuantos !== null && (!Number.isInteger(cuantos) || cuantos < 1 || cuantos > MAX_RANGO_DIAS)) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: `La cantidad de días no se entiende (un entero entre 1 y ${MAX_RANGO_DIAS}).`,
        });
      }
      const pordefecto = ultimosDias(cuantos ?? 30, zona, ancla);
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
      // El rango resuelto viaja de vuelta: la etiqueta del período y el eje
      // del gráfico tienen que nombrar la ventana que de verdad se midió, no
      // una que el navegador vuelva a calcular por su cuenta.
      return {
        ...(await getDashboard(c, { tenantId: actor.tenantId, from: desde, to: hasta, ownerId: dueño })),
        rango: { from: desde, to: hasta },
      };
    });
  }
}
