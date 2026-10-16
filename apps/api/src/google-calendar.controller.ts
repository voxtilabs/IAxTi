import { BadRequestException, Controller, Get, Header, HttpCode, Inject, Post, Req, Res, ServiceUnavailableException, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import type { Response } from 'express';
import { z } from 'zod';
import { createQueue, redisConnection } from '@iaxti/core';
import { estadoGoogleCalendar, iniciarGoogleCalendar, completarGoogleCalendar, revocarGoogleCalendar, autenticarPushGoogle } from '@iaxti/module-calendar';
import { RequireAuth, RequireModule, RequirePermission } from './authz/decorators';
import type { WithUser } from './authz/authz.guard';
import type { WithRequestId } from './request-id';
import { apiPool } from './db';
import { Cuerpo } from './validar';
import { RESPUESTA_SENSIBLE } from './idempotencia.interceptor';

export const GOOGLE_CALENDAR_HTTP = 'GOOGLE_CALENDAR_HTTP';
export interface GooglePushJob { moduleId: 'calendar'; tenantId: string; channelId: string; resourceId: string; messageNumber: string; requestId?: string }
let queue: ReturnType<typeof createQueue> | undefined;
export const googleCalendarHttp = {
  pool: apiPool,
  async enqueue(data: GooglePushJob): Promise<void> {
    queue ??= createQueue('inbound', redisConnection());
    await queue.add('google-calendar.push', data, { jobId: `google-${data.channelId}-${data.messageNumber}` });
  },
};
export type GoogleCalendarHttp = typeof googleCalendarHttp;
const iniciar = z.object({ challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Vuelve a iniciar la conexión desde Agenda.') }).strict();
const completar = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'La conexión no es válida. Iníciala otra vez.'),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'La conexión no es válida. Iníciala otra vez.'),
  verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/, 'Vuelve a iniciar desde el navegador donde conectaste Google.'),
  code: z.string().min(1).max(8192).regex(/^[^\r\n\0]+$/, 'Google no entregó un permiso válido. Vuelve a conectar.'),
}).strict();
function pool(deps: GoogleCalendarHttp) {
  const result = deps.pool();
  if (!result) throw new ServiceUnavailableException({ code: 'DB_NOT_CONFIGURED', message: 'No pudimos abrir la conexión. Intenta más tarde.' });
  return result;
}
function actor(request: WithUser) {
  const { tenantId, userId } = request.actor!;
  return { tenantId, userId };
}
function fallo(): never {
  // El módulo y el transporte ya auditan. No reflejar excepciones externas,
  // SQL ni tokens como mensaje HTTP, aunque una dependencia falle inesperadamente.
  throw new BadRequestException({ code: 'GOOGLE_CALENDAR_FAILED', message: 'No pudimos completar la conexión con Google. Revisa el permiso y vuelve a intentar desde Agenda.' });
}

@ApiTags('calendar')
@Controller('agenda/google')
@RequireModule('calendar')
@RequireAuth({ jwtOnly: true })
export class GoogleCalendarController {
  constructor(@Inject(GOOGLE_CALENDAR_HTTP) private readonly deps: GoogleCalendarHttp) {}

  @Get()
  @RequirePermission('calendar.read')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Estado de mi conexión con Google Calendar' })
  async estado(@Req() request: WithUser) {
    return estadoGoogleCalendar(pool(this.deps), actor(request));
  }

  @ApiBody({ schema: z.toJSONSchema(iniciar, { target: 'openapi-3.0' }) as SchemaObject })
  @Post('iniciar')
  @HttpCode(200)
  @RequirePermission('calendar.connect')
  @Header('Cache-Control', 'no-store')
  @SetMetadata(RESPUESTA_SENSIBLE, true)
  @ApiOperation({ summary: 'Iniciar consentimiento personal de Google con PKCE' })
  async iniciar(@Req() request: WithUser, @Cuerpo(iniciar) body: z.infer<typeof iniciar>) {
    try { return await iniciarGoogleCalendar(pool(this.deps), { ...actor(request), ...body }); } catch { return fallo(); }
  }

  @ApiBody({ schema: z.toJSONSchema(completar, { target: 'openapi-3.0' }) as SchemaObject })
  @Post('completar')
  @HttpCode(200)
  @RequirePermission('calendar.connect')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Canjear una vez el consentimiento de Google para mi negocio' })
  async completar(@Req() request: WithUser, @Cuerpo(completar) body: z.infer<typeof completar>) {
    try { return await completarGoogleCalendar(pool(this.deps), { ...actor(request), ...body }); } catch { return fallo(); }
  }

  @Post('revocar')
  @HttpCode(200)
  @RequirePermission('calendar.connect')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Revocar los permisos de esta cuenta Google concedidos a la aplicación' })
  async revocar(@Req() request: WithUser) {
    try { return await revocarGoogleCalendar(pool(this.deps), actor(request)); } catch { return fallo(); }
  }
}

@ApiTags('webhooks')
@Controller('webhooks/google/calendar')
@RequireModule('calendar')
export class GoogleCalendarWebhookController {
  constructor(@Inject(GOOGLE_CALENDAR_HTTP) private readonly deps: GoogleCalendarHttp) {}

  @ApiHeader({ name: 'X-Goog-Channel-Id', required: true, description: 'Identificador del canal registrado.' })
  @ApiHeader({ name: 'X-Goog-Channel-Token', required: true, description: 'Credencial del canal; no se registra ni encola.' })
  @ApiHeader({ name: 'X-Goog-Resource-Id', required: true, description: 'Recurso registrado en el canal.' })
  @ApiHeader({ name: 'X-Goog-Resource-State', required: true, enum: ['sync', 'exists', 'not_exists'] })
  @ApiHeader({ name: 'X-Goog-Message-Number', required: true, description: 'Número creciente, no necesariamente consecutivo.' })
  @Post()
  @HttpCode(204)
  @ApiOperation({ summary: 'Notificación Google Calendar: validar canal, encolar y responder' })
  @ApiResponse({ status: 204, description: 'Notificación encolada o sync inicial sin datos.' })
  async recibir(@Req() request: WithRequestId, @Res({ passthrough: true }) response: Response): Promise<void> {
    const header = (name: string) => typeof request.headers[name] === 'string' ? request.headers[name] as string : '';
    // Google puede enviar sync antes de que watch devuelva el resourceId. No
    // contiene cambios: responder no otorga acceso ni modifica estado alguno.
    if (header('x-goog-resource-state') === 'sync') return;
    const state = header('x-goog-resource-state');
    const channelId = header('x-goog-channel-id');
    const channelToken = header('x-goog-channel-token');
    const resourceId = header('x-goog-resource-id');
    const messageNumber = header('x-goog-message-number');
    const invalid = () => new UnauthorizedException({ code: 'GOOGLE_PUSH_INVALID', message: 'No pudimos validar esta notificación.' });
    if (!['exists', 'not_exists'].includes(state) || !/^[1-9][0-9]{0,29}$/.test(messageNumber)) throw invalid();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // La credencial es el token del canal y el recurso registrado, no un
      // HMAC inventado. El job nunca conserva ese token ni el cuerpo recibido.
      await Promise.race([
        (async () => {
          const tenantId = await autenticarPushGoogle(pool(this.deps), { channelId, channelToken, resourceId });
          if (!tenantId) throw invalid();
          await this.deps.enqueue({ moduleId: 'calendar', tenantId, channelId, resourceId, messageNumber, requestId: request.requestId });
        })(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error()), 800); timer.unref?.(); }),
      ]);
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      response.setHeader('Retry-After', '5');
      throw new ServiceUnavailableException({ code: 'GOOGLE_PUSH_RETRY', message: 'No pudimos guardar la notificación. Reintenta en unos segundos.' });
    } finally { clearTimeout(timer); }
  }
}
