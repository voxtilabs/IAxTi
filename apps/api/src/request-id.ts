import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { conContextoDeLog } from '@iaxti/telemetry';

export interface WithRequestId extends Request {
  requestId?: string;
}

/**
 * X-Request-Id entra o se genera, y se propaga a la respuesta, los logs y
 * el formato de error (SPEC §28). Formato: req_ + 24 hex.
 */
export function requestIdMiddleware(req: WithRequestId, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const requestId =
    typeof incoming === 'string' && /^[\w.-]{8,64}$/.test(incoming)
      ? incoming
      : `req_${randomBytes(12).toString('hex')}`;
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  // Todo lo que se loguee atendiendo este request lleva su id. El tenant se
  // agrega después, cuando el guard resuelve quién es: acá todavía no se
  // sabe, y poner uno adivinado sería peor que no poner ninguno.
  conContextoDeLog({ requestId }, next);
}
