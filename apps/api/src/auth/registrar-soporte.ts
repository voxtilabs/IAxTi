import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';

/**
 * Deja rastro de CADA acceso del soporte al tenant (SPEC §22, issue 219).
 *
 * El modo soporte abre lectura cross-tenant, que es lo único que rompe el
 * aislamiento a propósito. Que quede escrito en el libro del tenant no es un
 * adorno: es lo que le permite a un cliente preguntar quién miró sus
 * conversaciones y cuándo, y lo que nos permite responder.
 *
 * Best-effort como el registro de rechazos: el acceso ya se autorizó por la
 * sesión viva, y una escritura de audit caída no puede voltear la request.
 */
export function registrarSoporte(pool: Pool | null) {
  return (info: {
    tenantId: string;
    userId: string;
    sessionId?: string;
    permission?: string;
    resource?: string;
    ip?: string;
    requestId?: string;
  }): void => {
    if (!pool) return;
    void withTenant(pool, info.tenantId, (c) =>
      writeAudit(c, {
        tenantId: info.tenantId,
        actor: info.userId,
        actorKind: 'superadmin',
        action: 'platform.support.access',
        resource: info.resource ?? info.permission ?? 'desconocido',
        result: 'ok',
        ip: info.ip,
        requestId: info.requestId,
        metadata: { sessionId: info.sessionId ?? null, permission: info.permission ?? null },
      }),
    ).catch((err: Error) => {
      console.warn(`[${info.requestId}] no pudimos auditar el acceso de soporte — ${err.message}`);
    });
  };
}
