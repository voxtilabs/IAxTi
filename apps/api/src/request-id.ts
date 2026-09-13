import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

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
  next();
}
