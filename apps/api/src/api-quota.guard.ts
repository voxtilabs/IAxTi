import { HttpException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type IORedis from 'ioredis';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { publishEvent } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import { apiRequestsLimit } from '@iaxti/module-organizations';
import type { WithUser } from './authz/authz.guard';

// La cuota MENSUAL de la API (#25, SPEC §28): solo cuenta lo que entra
// con API key (la app del equipo no se come la cuota del cliente). El
// tope vive en el plan + override del SuperAdmin; al 80 % y 100 % sale
// usage.threshold_reached UNA vez por ciclo.

const CACHE_TTL_MS = 60_000;

function periodo(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function segundosHastaFinDeMes(now = new Date()): number {
  const fin = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.floor((fin - now.getTime()) / 1000));
}

@Injectable()
export class ApiQuotaGuard implements CanActivate {
  private readonly cache = new Map<string, { limit: number | null; at: number }>();

  constructor(
    private readonly redis: IORedis,
    private readonly pool: Pool | null,
  ) {}

  private async limitFor(tenantId: string): Promise<number | null> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.limit;
    if (!this.pool) return null;
    const limit = await withTenant(this.pool, tenantId, (c) => apiRequestsLimit(c, tenantId));
    this.cache.set(tenantId, { limit, at: Date.now() });
    return limit;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WithUser>();
    // Corre DESPUÉS del AuthzGuard: solo aplica a requests con API key.
    if (request.actor?.kind !== 'apikey') return true;
    const response = context.switchToHttp().getResponse<Response>();
    const tenantId = request.actor.tenantId;
    const per = periodo();

    const usada = await this.redis.incr(`apiq:m:${tenantId}:${per}`);
    if (usada === 1) await this.redis.expire(`apiq:m:${tenantId}:${per}`, 40 * 86_400);
    // Los contadores del dashboard (#26): por día y por endpoint.
    const dia = new Date().toISOString().slice(0, 10);
    const endpoint = `${request.method} ${request.path.replace(/[0-9a-f-]{36}/g, ':id')}`.slice(0, 120);
    void this.redis
      .multi()
      .incr(`apiq:d:${tenantId}:${dia}`)
      .expire(`apiq:d:${tenantId}:${dia}`, 3 * 86_400)
      .incr(`apiq:e:${tenantId}:${dia}:${endpoint}`)
      .expire(`apiq:e:${tenantId}:${dia}:${endpoint}`, 3 * 86_400)
      .exec()
      .catch(() => {});

    const limit = await this.limitFor(tenantId);
    if (limit === null) return true; // sin tope conocido: no se corta

    response.setHeader('X-Api-Quota-Limit', String(limit));
    response.setHeader('X-Api-Quota-Remaining', String(Math.max(limit - usada, 0)));
    response.setHeader('X-Api-Quota-Reset', String(segundosHastaFinDeMes()));

    // Umbrales 80/100: UNA vez por ciclo (SETNX) y el evento al outbox.
    for (const nivel of [80, 100] as const) {
      if (usada >= Math.ceil((limit * nivel) / 100)) {
        const primerizo = await this.redis.setnx(`apiq:alert:${tenantId}:${per}:${nivel}`, '1');
        if (primerizo === 1) {
          await this.redis.expire(`apiq:alert:${tenantId}:${per}:${nivel}`, 40 * 86_400);
          if (this.pool) {
            await withTenant(this.pool, tenantId, (c) =>
              publishEvent(c, {
                name: 'usage.threshold_reached',
                tenantId,
                payload: { metric: 'api_requests', level: nivel, used: usada, limit },
                actor: 'system',
              }),
            ).catch(() => {});
          }
        }
      }
    }

    if (usada > limit) {
      response.setHeader('Retry-After', String(segundosHastaFinDeMes()));
      throw new HttpException(
        {
          code: 'QUOTA_EXCEEDED',
          message:
            'Tu cuota mensual de la API se completó. Sube de plan o pide una ampliación — el contador parte de nuevo el próximo mes.',
        },
        429,
      );
    }
    return true;
  }
}
