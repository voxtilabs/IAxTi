import type { Pool } from 'pg';
import { redisConnection } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';

// Deja rastro de un rechazo (#71). BEST-EFFORT por definición: negar el
// acceso ya pasó; si el registro falla, se avisa por log y nada más. Un
// tablero de seguridad no puede ser motivo de que caiga una request.

let redisSingleton: ReturnType<typeof redisConnection> | null = null;
function redis(): ReturnType<typeof redisConnection> | null {
  if (!process.env.REDIS_URL) return null;
  redisSingleton ??= redisConnection();
  return redisSingleton;
}

export function registrarRechazo(pool: Pool | null) {
  return (info: {
    kind: 'permiso' | 'autenticacion';
    tenantId?: string;
    userId?: string;
    permission?: string;
    ip?: string;
    requestId?: string;
  }): void => {
    // La autenticación rechazada no tiene tenant: no hay libro donde
    // escribirla, así que va a un contador.
    if (info.kind === 'autenticacion') {
      void redis()?.incr('sec:auth_rechazado:total').catch(() => {});
      return;
    }
    if (!pool || !info.tenantId || !info.userId) return;
    void withTenant(pool, info.tenantId, (c) =>
      writeAudit(c, {
        tenantId: info.tenantId!,
        actor: info.userId!,
        actorKind: 'user',
        action: 'permission.denied',
        resource: info.permission ?? 'desconocido',
        result: 'denied',
        ip: info.ip,
        requestId: info.requestId,
      }),
    ).catch((err: Error) => {
      console.warn(`[${info.requestId}] no pudimos auditar el rechazo — ${err.message}`);
    });
  };
}
