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
import { z } from 'zod';
import {
  domainAllowed,
  findWidgetById,
  getSessionReplies,
  postVisitorMessage,
  startSession,
} from '@iaxti/module-webchat';
import type { Widget } from '@iaxti/module-webchat';
import { createQueue, redisConnection } from '@iaxti/core';
import { textoRequerido, validar } from './validar';
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

/** El mismo texto que respondía la ruta cuando faltaba uno de los dos (#524). */
const FALTA_SESION_O_MENSAJE = 'Falta la sesión o el mensaje.';

/**
 * El mensaje del visitante (#524).
 *
 * Los dos campos obligatorios comparten el mensaje porque es el que la ruta ya
 * respondía, y lo lee el visitante con el chat abierto. `sessionId` va PRIMERO
 * a propósito: si no viene ninguno de los dos, el primer `details` sigue siendo
 * el suyo, como cuando era un `if` con ternario.
 *
 * `page` y `visitor` quedan opcionales porque lo eran: sin `page` la respuesta
 * no es un 400 sino el 404 mudo del dominio, y la identidad llega recién con el
 * segundo mensaje (#46).
 */
const MensajeDelVisitante = z.object({
  page: z.string().optional(),
  // A mano y SIN `.trim()`, al contrario que el texto: hoy un id con espacios
  // pasa esta comprobación y lo rechaza la consulta de la sesión con su propio
  // código (WEBCHAT_ERROR, «La sesión del chat expiró. Recarga la página.»). El
  // atajo lo recortaría y lo volvería VALIDATION_ERROR, que es mover el
  // contrato. El mensaje va en el tipo y en el largo: sin el campo falla el
  // tipo, no el largo.
  sessionId: z.string({ error: FALTA_SESION_O_MENSAJE }).min(1, FALTA_SESION_O_MENSAJE),
  // El texto sí se recorta, porque la comprobación de hoy es `body.trim()`: un
  // mensaje de puros espacios no es un mensaje.
  body: textoRequerido(FALTA_SESION_O_MENSAJE),
  visitor: z
    .object({
      name: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
});

@ApiTags('webchat')
@Controller('webchat/:widgetId')
export class WebchatController {
  @Get('config')
  @ApiOperation({ summary: 'Configuración pública del widget' })
  async config(@Param('widgetId') widgetId: string, @Query('page') page?: string) {
    const widget = await widgetValido(widgetId, page);
    return { name: widget.name, welcomeMessage: widget.welcomeMessage };
  }

  /**
   * Esta ruta se queda con `@Body()` y sin esquema (#524): no tiene ningún
   * VALIDATION_ERROR que convertir. `page` es lo único que llega y quien decide
   * si se responde es el dominio del widget, con su 404 mudo; exigirlo acá
   * sería agregar una validación que hoy no existe, y eso también mueve el
   * contrato.
   */
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
    // `Partial` porque en este punto el cuerpo todavía no pasó por el esquema:
    // lo único que se lee antes de validarlo es `page`.
    @Body() body: Partial<z.input<typeof MensajeDelVisitante>>,
  ) {
    // El esquema se aplica con `validar` y no con `@Cuerpo` por el ORDEN: un
    // pipe corre ANTES del método, y acá el dominio va primero. El dominio es
    // la autenticación de esta ruta pública y fuera de él la respuesta es 404
    // mudo: validando antes, un sitio que no tiene permiso para incrustar el
    // widget dejaría de recibir silencio y pasaría a recibir un 400 con los
    // campos que le faltan. Un cuerpo vacío —sin `page` ni `sessionId`— es
    // justo ese caso.
    const widget = await widgetValido(widgetId, body?.page);
    const datos = validar(MensajeDelVisitante, body ?? {});
    try {
      const res = await withTenant(pool(), widget.tenantId, (c) =>
        postVisitorMessage(c, {
          widget,
          sessionId: datos.sessionId,
          body: datos.body,
          visitor: datos.visitor,
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
