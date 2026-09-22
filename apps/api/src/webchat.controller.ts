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
import { createQueue, redisConnection } from '@iaxti/core';
import { apiPool } from './db';
import { registry } from './registry';
import type { WithRequestId } from './request-id';

// El lado PÚBLICO del webchat (#46): lo consume el iframe del widget desde
// el origen de la app (mismo CORS que web/admin). El token del widget +
// el referrer del sitio son la autenticación; fuera de dominio, 404 mudo.

/**
 * El copiloto para el webchat (#438).
 *
 * Los mensajes de WhatsApp y del simulador entran por la cola `inbound`, y
 * ES ESE worker el que encola la sugerencia. El webchat escribe directo en
 * la bandeja —para que el visitante vea su mensaje al tiro— y por eso se
 * saltaba al copiloto entero: el único canal que funciona sin proveedor,
 * el que sirve para partir hoy, era también el único sin asistente.
 *
 * Va DESPUÉS de responder el mensaje y no antes: la respuesta al visitante
 * no espera a Redis. Y si encolar falla, el mensaje ya está en la bandeja —
 * se pierde la sugerencia, no la conversación.
 */
let colaDeAgentes: ReturnType<typeof createQueue> | null = null;
async function pedirSugerencia(
  tenantId: string,
  res: { status: string; conversationId?: string; messageId?: string },
  requestId?: string,
): Promise<void> {
  if (res.status !== 'delivered' || !res.conversationId || !res.messageId) return;
  if (!registry.isActive('agents')) return;
  try {
    colaDeAgentes ??= createQueue('agents', redisConnection());
    await colaDeAgentes.add(
      'suggest',
      {
        moduleId: 'agents',
        tenantId,
        conversationId: res.conversationId,
        messageId: res.messageId,
        knowledgeActivo: registry.isActive('knowledge'),
        requestId,
      },
      // El MISMO jobId que usa el worker de entrada: si algún día el
      // webchat pasara por esa cola, el duplicado ni entra.
      { jobId: `sg-${res.messageId}` },
    );
  } catch (error) {
    console.warn(`webchat: no se pudo pedir la sugerencia: ${(error as Error).message}`);
  }
}

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
      const res = await withTenant(pool(), widget.tenantId, (c) =>
        postVisitorMessage(c, {
          widget,
          sessionId: body.sessionId!,
          body: body.body!,
          visitor: body.visitor,
          requestId: request.requestId,
        }),
      );
      await pedirSugerencia(widget.tenantId, res, request.requestId);
      return res;
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
