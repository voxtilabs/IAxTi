import {
  HttpException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type IORedis from 'ioredis';
import type { Response } from 'express';
import type { WithRequestId } from './request-id';
import { enteroDeEntorno } from '@iaxti/core';

/**
 * Rate limiting por tenant y por API key en Redis (SPEC §28): ventana fija
 * por minuto, claves SIEMPRE prefijadas por tenant, cabeceras RateLimit-* en
 * toda respuesta y 429 con el formato de error único.
 *
 * La identidad viene de los headers hasta que exista auth real (#7/#9):
 * X-Api-Key manda sobre X-Tenant-Id; sin ninguno, se limita por IP.
 * El gancho para la cuota mensual por plan (#25) es el mismo contador con
 * ventana de ciclo en vez de minuto.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: IORedis,
    private readonly limitPerMinute = enteroDeEntorno('RATE_LIMIT_PER_MINUTE', 120),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WithRequestId>();
    const response = context.switchToHttp().getResponse<Response>();

    // Salud y docs quedan fuera: Dokploy y Uptime Kuma no consumen cuota.
    if (/^\/(health|ready|docs)/.test(request.path)) return true;

    const apiKey = request.headers['x-api-key'];
    const tenant = request.headers['x-tenant-id'];
    const subject =
      typeof apiKey === 'string'
        ? `key:${apiKey.slice(0, 16)}`
        : typeof tenant === 'string'
          ? `tenant:${tenant}`
          : `ip:${request.ip ?? 'desconocida'}`;

    const window = Math.floor(Date.now() / 60_000);
    const redisKey = `rl:${subject}:${window}`;

    const used = await this.redis.incr(redisKey);
    if (used === 1) await this.redis.expire(redisKey, 90);

    const remaining = Math.max(this.limitPerMinute - used, 0);
    const resetSeconds = 60 - Math.floor((Date.now() % 60_000) / 1_000);
    response.setHeader('RateLimit-Limit', String(this.limitPerMinute));
    response.setHeader('RateLimit-Remaining', String(remaining));
    response.setHeader('RateLimit-Reset', String(resetSeconds));

    if (used > this.limitPerMinute) {
      response.setHeader('Retry-After', String(resetSeconds));
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Demasiadas solicitudes seguidas. Espera un momento y reintenta.',
        },
        429,
      );
    }
    return true;
  }
}
