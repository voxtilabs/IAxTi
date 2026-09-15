import {
  Injectable,
  ServiceUnavailableException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { EstadoRls } from '@iaxti/db';
import type { WithRequestId } from './request-id';

/**
 * Sin aislamiento verificado, la API no sirve datos (issue 227).
 *
 * El primer intento de esto fue matar el proceso al arrancar (#212) y salió
 * mal: un contenedor que muere entra en ciclo de reinicio, el proxy le quita
 * la ruta y lo único que se ve desde afuera es un 404 pelado. El motivo
 * queda enterrado en un log. Staging estuvo así una hora el 15/09 mientras
 * yo apostaba a ciegas.
 *
 * Esta es la versión que corresponde: el proceso sigue vivo —los logs se
 * leen, `/health` responde, el rollback es posible— y lo que se niega es
 * SERVIR. Quien mire recibe un 503 que dice qué pasa.
 *
 * Tres candados a propósito:
 *  1. solo en producción: en staging no hay datos reales y bloquear todo
 *     impide justamente el trabajo de arreglarlo;
 *  2. solo si la comprobación se PUDO hacer: "no pudimos preguntar" jamás
 *     puede leerse como "está mal";
 *  3. salud y documentación siguen abiertas: son las que permiten
 *     diagnosticar.
 */
const ABIERTAS = /^\/(health|ready|docs|metrics)/;

@Injectable()
export class AislamientoGuard implements CanActivate {
  constructor(
    private readonly estado: () => EstadoRls | null,
    private readonly entorno = process.env.IAXTI_ENV ?? 'development',
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<WithRequestId>();
    if (ABIERTAS.test(request.path)) return true;
    if (this.entorno !== 'production') return true;

    const estado = this.estado();
    if (!estado || !estado.verificado || !estado.seSalta) return true;

    throw new ServiceUnavailableException({
      code: 'SIN_AISLAMIENTO',
      message:
        `Esta instancia se conecta a la base con el rol "${estado.rol}", que se salta ` +
        'las políticas por tenant. No se sirve nada hasta que use un rol de aplicación ' +
        '(runbook: "El rol con el que la aplicación se conecta a Postgres").',
    });
  }
}
