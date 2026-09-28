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
    /**
     * Por minuto y por tenant (SPEC §28, `.claude/rules/api.md`).
     *
     * Estaba en 120 y es demasiado bajo, medido y no estimado (#686). Una sola
     * prueba de la bandeja —un usuario abre una conversación y responde un
     * mensaje— hace **31 llamadas a /v1**, contadas en la traza de red:
     * detalle, mensajes, notas, sugerencia, análisis, límites de adjuntos, la
     * lista, y las que repite al refrescar después de actuar.
     *
     * Con 120 el negocio ENTERO tenía cuatro de esos flujos por minuto, entre
     * todos sus usuarios: el cupo es por tenant, no por persona. Tres personas
     * trabajando la bandeja a ritmo normal lo agotan, y a partir de ahí el
     * producto contesta «Espera un momento» a gente que solo está trabajando.
     * Eso ya se vio: el mensaje que no se enviaba.
     *
     * 1200 es 20 por segundo sostenidos para un negocio completo. Sigue
     * acotando el abuso —que es para lo que existe esto— y deja de castigar el
     * uso normal. Sube por variable si algún tenant grande lo necesita.
     */
    private readonly limitPerMinute = enteroDeEntorno('RATE_LIMIT_PER_MINUTE', 1200),
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
