import { Controller, Get, Req, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { redisConnection } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import { apiRequestsLimit, getUsage } from '@iaxti/module-organizations';
import { RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

// El consumo de API del PROPIO tenant (#26): contra su cuota, con la
// evolución por día y los endpoints más usados. UsageMeter es la fuente;
// el mes vivo se completa con el contador de Redis (lo aún no volcado).

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

let redisSingleton: ReturnType<typeof redisConnection> | null = null;
function redisApi(): ReturnType<typeof redisConnection> {
  redisSingleton ??= redisConnection();
  return redisSingleton;
}

function actorOf(request: WithUser): Actor {
  return request.actor as Actor;
}

@ApiTags('apikeys')
@Controller('api-usage')
export class ApiUsageController {
  @Get()
  @RequirePermission('apikeys.manage')
  @ApiOperation({ summary: 'El consumo de la API del tenant contra su cuota' })
  async usage(@Req() request: WithUser) {
    const actor = actorOf(request);
    const per = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
    const vivo = Number((await redisApi().get(`apiq:m:${actor.tenantId}:${per}`)) ?? 0);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const [limit, volcado] = await Promise.all([
        apiRequestsLimit(c, actor.tenantId),
        getUsage(c, actor.tenantId, 'api_requests'),
      ]);
      const porDia = await c.query(
        `SELECT day::text, SUM(value)::int AS n FROM daily_metrics
          WHERE tenant_id = $1 AND metric = 'api_requests'
            AND day > now()::date - 30
          GROUP BY day ORDER BY day`,
        [actor.tenantId],
      );
      const topEndpoints = await c.query(
        `SELECT replace(metric, 'api_ep:', '') AS endpoint, SUM(value)::int AS n
           FROM daily_metrics
          WHERE tenant_id = $1 AND metric LIKE 'api_ep:%'
            AND day > now()::date - 30
          GROUP BY metric ORDER BY SUM(value) DESC LIMIT 10`,
        [actor.tenantId],
      );
      // El mes vivo manda: Redis lleva TODO el mes; usage_meters solo lo
      // ya volcado — se informa el mayor, jamás menos de lo real.
      const used = Math.max(vivo, volcado);
      return {
        limit,
        used,
        pct: limit ? Math.round((used / limit) * 100) : null,
        porDia: porDia.rows,
        topEndpoints: topEndpoints.rows,
      };
    });
  }
}
