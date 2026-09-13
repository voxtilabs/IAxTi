import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import type { WithRequestId } from './request-id';

/** Formato de error único de la plataforma (SPEC §28). */
export interface ApiError {
  code: string;
  message: string;
  requestId: string;
  details: unknown[];
}

const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
};

// Voz Pulso: qué pasó y qué hacer, sin "Error:", sin el mensaje crudo.
const MESSAGE_BY_STATUS: Record<number, string> = {
  400: 'La solicitud viene con datos que no calzan. Revisa los campos e intenta de nuevo.',
  401: 'Necesitas iniciar sesión para hacer esto.',
  403: 'Tu rol no permite esta acción. Pídele acceso a quien administra el equipo.',
  404: 'No encontramos lo que buscas. Puede que se haya eliminado.',
  409: 'Alguien más cambió esto antes que tú. Recarga y vuelve a intentarlo.',
  429: 'Demasiadas solicitudes seguidas. Espera un momento y reintenta.',
};

@Catch()
export class ErrorsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<WithRequestId>();
    const requestId = request.requestId ?? '';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL';
    let message = 'Algo falló de nuestro lado. Ya quedó registrado; intenta de nuevo en un momento.';
    let details: unknown[] = [];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = CODE_BY_STATUS[status] ?? `HTTP_${status}`;
      message = MESSAGE_BY_STATUS[status] ?? message;

      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        // El message solo se respeta cuando el error es nuestro (trae code):
        // los por defecto de Nest ("Cannot GET /x") no llegan al cliente.
        if (typeof b.code === 'string') {
          code = b.code;
          if (typeof b.message === 'string') message = b.message;
        }
        if (Array.isArray(b.message)) details = b.message; // class-validator
        if (Array.isArray(b.details)) details = b.details;
      }
    } else {
      // Error no controlado: se loguea completo, al cliente va el genérico.
      console.error(`[${requestId}]`, exception);
    }

    const body: ApiError = { code, message, requestId, details };
    response.status(status).json(body);
  }
}
