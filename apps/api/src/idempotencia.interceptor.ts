import {
  HttpException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Pool } from 'pg';
import type { Response } from 'express';
import { from, of, switchMap, tap, catchError, throwError } from 'rxjs';
import { withTenant } from '@iaxti/db';
import { guardarRespuesta, reservarLlave, soltarLlave } from '@iaxti/core';
import type { WithRequestId } from './request-id';

/**
 * Idempotency-Key (SPEC §28): la cabecera estaba documentada en el OpenAPI y
 * permitida por CORS desde el primer día, y no la leía nadie. Un POST
 * reintentado —una red que se corta, un botón apretado dos veces— creaba el
 * trato dos veces y generaba el link de cobro dos veces.
 *
 * Solo actúa sobre POST y solo si el cliente manda la cabecera: quien no la
 * usa no cambia de comportamiento. La llave es POR TENANT, como todo acá.
 */
@Injectable()
export class IdempotenciaInterceptor implements NestInterceptor {
  constructor(private readonly pool: Pool) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<WithRequestId>();
    const response = context.switchToHttp().getResponse<Response>();
    const key = request.headers['idempotency-key'];
    const tenantId = (request as { actor?: { tenantId?: string } }).actor?.tenantId;

    if (request.method !== 'POST' || typeof key !== 'string' || !key.trim() || !tenantId) {
      return next.handle();
    }
    if (key.length > 255) {
      throw new HttpException({ code: 'IDEMPOTENCY_KEY_INVALIDA', message: 'Idempotency-Key demasiado larga.' }, 400);
    }

    const datos = { tenantId, key, method: request.method, path: request.path, body: request.body };
    return from(withTenant(this.pool, tenantId, (c) => reservarLlave(c, datos))).pipe(
      switchMap((reserva) => {
        if (reserva.estado === 'repetida') {
          // La MISMA respuesta que la primera vez, sin ejecutar nada.
          response.setHeader('Idempotent-Replay', 'true');
          response.status(reserva.respuesta?.status ?? 200);
          return of(reserva.respuesta?.body ?? null);
        }
        if (reserva.estado === 'en_curso') {
          throw new HttpException(
            { code: 'IDEMPOTENCY_EN_CURSO', message: 'Ese mismo pedido todavía se está procesando.' },
            409,
          );
        }
        if (reserva.estado === 'conflicto') {
          throw new HttpException(
            { code: 'IDEMPOTENCY_LLAVE_REUSADA', message: 'Esa Idempotency-Key ya se usó para otro pedido.' },
            422,
          );
        }
        return next.handle().pipe(
          tap((body) => {
            void withTenant(this.pool, tenantId, (c) =>
              guardarRespuesta(c, { tenantId, key, status: response.statusCode, body }),
            ).catch(() => {});
          }),
          catchError((err) =>
            // El pedido falló: se suelta la llave para que el cliente pueda
            // reintentar con la misma. Guardar el fallo sería condenarlo a
            // recibir ese error para siempre.
            from(withTenant(this.pool, tenantId, (c) => soltarLlave(c, { tenantId, key })))
              .pipe(
                catchError(() => of(null)),
                switchMap(() => throwError(() => err)),
              ),
          ),
        );
      }),
    );
  }
}
