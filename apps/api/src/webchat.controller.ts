import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  domainAllowed,
  findWidgetById,
  getSessionReplies,
  postVisitorMessage,
  startSession,
} from '@iaxti/module-webchat';
import type { Widget } from '@iaxti/module-webchat';
import { apiPool } from './db';
import type { WithRequestId } from './request-id';

// El lado PÚBLICO del webchat (#46): lo consume el iframe del widget desde
// el origen de la app (mismo CORS que web/admin). El token del widget +
// el referrer del sitio son la autenticación; fuera de dominio, 404 mudo.

function pool() {
  const p = apiPool();
  if (!p) {
    throw new ServiceUnavailableException({
      code: 'DB_NOT_CONFIGURED',
      message: 'El servidor aún no tiene base de datos configurada. Intenta más tarde.',
    });
  }
  return p;
}

async function widgetValido(widgetId: string, pageUrl: string | undefined): Promise<Widget> {
  const client = await pool().connect();
  let widget: Widget | null;
  try {
    widget = await findWidgetById(client, widgetId);
  } finally {
    client.release();
  }
  if (!widget || !widget.active || !domainAllowed(widget, pageUrl)) {
    throw new NotFoundException({ code: 'NOT_FOUND', message: 'Nada por aquí.' });
  }
  return widget;
}

@ApiTags('webchat')
@Controller('webchat/:widgetId')
export class WebchatController {
  @Get('config')
  @ApiOperation({ summary: 'Configuración pública del widget' })
  async config(@Param('widgetId') widgetId: string, @Query('page') page?: string) {
    const widget = await widgetValido(widgetId, page);
    return { name: widget.name, welcomeMessage: widget.welcomeMessage };
  }

  @Post('sessions')
  @ApiOperation({ summary: 'Abre una sesión de visitante' })
  async session(@Param('widgetId') widgetId: string, @Body() body: { page?: string }) {
    const widget = await widgetValido(widgetId, body?.page);
    const session = await withTenant(pool(), widget.tenantId, (c) =>
      startSession(c, { tenantId: widget.tenantId, widgetId: widget.id }),
    );
    return { sessionId: session.id, welcomeMessage: widget.welcomeMessage };
  }

  @Post('messages')
  @ApiOperation({ summary: 'Mensaje del visitante (identidad antes del segundo)' })
  async message(
    @Req() request: WithRequestId,
    @Param('widgetId') widgetId: string,
    @Body()
    body: {
      page?: string;
      sessionId?: string;
      body?: string;
      visitor?: { name?: string; phone?: string; email?: string };
    },
  ) {
    const widget = await widgetValido(widgetId, body?.page);
    if (!body?.sessionId || !body?.body?.trim()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Falta la sesión o el mensaje.',
        details: [{ field: !body?.sessionId ? 'sessionId' : 'body' }],
      });
    }
    try {
      return await withTenant(pool(), widget.tenantId, (c) =>
        postVisitorMessage(c, {
          widget,
          sessionId: body.sessionId!,
          body: body.body!,
          visitor: body.visitor,
          requestId: request.requestId,
        }),
      );
    } catch (err) {
      throw new BadRequestException({ code: 'WEBCHAT_ERROR', message: (err as Error).message });
    }
  }

  @Get('messages')
  @ApiOperation({ summary: 'Respuestas del equipo (sondeo del widget)' })
  async replies(
    @Param('widgetId') widgetId: string,
    @Query('page') page?: string,
    @Query('sessionId') sessionId?: string,
    @Query('after') after?: string,
  ) {
    const widget = await widgetValido(widgetId, page);
    if (!sessionId) return [];
    return withTenant(pool(), widget.tenantId, (c) =>
      getSessionReplies(c, { widget, sessionId, afterIso: after }),
    );
  }
}
