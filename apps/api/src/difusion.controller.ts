import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  DifusionError,
  enviarDifusion,
  previsualizarDifusion,
  reintentarDifusion,
  resultadoDifusion,
} from '@iaxti/module-conversations';
import type { ConversationState } from '@iaxti/module-conversations';
import { z } from 'zod';
import { RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo, idRequerido, textoRequerido } from './validar';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

/**
 * Escribirle a todos los que conversaron, desde la bandeja (#1247).
 *
 * Controller propio y no una ruta más de `ConversationsController` porque son
 * rutas de COLECCIÓN (`conversations/difusion/...`) y no de una conversación:
 * mezcladas, `difusion` competiría con `:id` por el primer segmento y el
 * orden de declaración pasaría a decidir qué ruta atiende qué.
 *
 * El permiso es `conversations.broadcast` y no `conversations.reply`: esto
 * manda WhatsApp de verdad a mucha gente de una vez. Responder es de quien
 * atiende; escribirle a todos es de quien administra el negocio, igual que
 * una campaña.
 */

function pool() {
  const p = apiPool();
  if (!p) {
    throw new NotFoundException({
      code: 'DB_NOT_CONFIGURED',
      message: 'El servidor aún no tiene base de datos configurada. Intenta más tarde.',
    });
  }
  return p;
}

function actorOf(request: WithUser): Actor {
  // El guard de @RequirePermission siempre lo adjunta.
  return request.actor as Actor;
}

/**
 * El esquema de entrada (#524), arriba de sus rutas y con el mensaje que lee
 * quien está cerrando el stand, no quien programa.
 *
 * El filtro entra suelto a propósito, como en campañas: la `etiquetaId` que no
 * es de este negocio simplemente no alcanza a nadie (RLS), y un `estado` que
 * no existe deja la lista vacía en vez de tirar la previsualización — que es
 * lo que menos debería fallar nunca.
 */
const NuevaPrevia = z.object({
  texto: textoRequerido('Escribe lo que les quieres decir antes de ver a quién le llega.'),
  filtro: z
    .object({
      estado: z.string().optional(),
      etiquetaId: z.string().optional(),
    })
    .optional(),
});

const Envio = z.object({ previaId: idRequerido('Indica la previsualización que se envía.') });

@ApiTags('conversations')
@Controller('conversations/difusion')
@RequireModule('conversations')
export class DifusionController {
  @Post('previa')
  @HttpCode(200)
  @RequirePermission('conversations.broadcast')
  @ApiOperation({ summary: 'A quién le llegaría: conteo, muestra y quienes quedan fuera, sin mandar nada' })
  async previa(
    @Req() request: WithUser,
    @Cuerpo(NuevaPrevia) body: z.infer<typeof NuevaPrevia>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      previsualizarDifusion(c, {
        tenantId: actor.tenantId,
        texto: body.texto.trim(),
        filtro: {
          estado: body.filtro?.estado as ConversationState | undefined,
          etiquetaId: body.filtro?.etiquetaId,
        },
        actor: actor.userId,
        actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
        requestId: request.requestId,
      }),
    );
  }

  /**
   * El envío. Manda exactamente a los destinatarios de la previa que SIGAN
   * correspondiendo (alguien pudo darse de baja entremedio) y persiste un
   * mensaje por persona.
   *
   * `Idempotency-Key` OBLIGATORIA: es un POST que crea, y el doble clic o la
   * red cortada no pueden volver a mandar los mismos WhatsApp.
   */
  @Post()
  @RequirePermission('conversations.broadcast')
  @ApiOperation({ summary: 'Envía la difusión de la previsualización, un mensaje por destinatario' })
  async enviar(@Req() request: WithUser, @Cuerpo(Envio) body: z.infer<typeof Envio>) {
    const actor = actorOf(request);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !key.trim() || key.length > 255) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Este envío necesita una clave de idempotencia. Vuelve a apretar Enviar.',
      });
    }
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        enviarDifusion(c, {
          tenantId: actor.tenantId,
          difusionId: body.previaId,
          actor: actor.userId,
          actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
          requestId: request.requestId,
        }),
      );
    } catch (err) {
      if (err instanceof DifusionError) {
        throw new BadRequestException({ code: 'DIFUSION_RECHAZADA', message: err.message });
      }
      throw err;
    }
  }

  @Get(':id')
  @RequirePermission('conversations.broadcast')
  @ApiOperation({ summary: 'Qué pasó con cada destinatario: estado de entrega y motivo del fallo' })
  async resultado(@Req() request: WithUser, @Param('id', new ParseUUIDPipe()) id: string) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        resultadoDifusion(c, { tenantId: actor.tenantId, difusionId: id }),
      );
    } catch (err) {
      if (err instanceof DifusionError) {
        // Otro tenant pregunta igual que si no existiera: misma respuesta que
        // la conversación ajena, sin confirmar que ahí hay algo.
        throw new NotFoundException({
          code: 'DIFUSION_NOT_FOUND',
          message: 'No encontramos ese envío en este negocio.',
        });
      }
      throw err;
    }
  }

  /** Reencola SOLO los fallidos; a quien recibió no se le vuelve a mandar. */
  @Post(':id/reintentar')
  @RequirePermission('conversations.broadcast')
  @ApiOperation({ summary: 'Reintenta los fallidos sin repetirle a quien ya recibió' })
  async reintentar(@Req() request: WithUser, @Param('id', new ParseUUIDPipe()) id: string) {
    const actor = actorOf(request);
    try {
      return await withTenant(pool(), actor.tenantId, (c) =>
        reintentarDifusion(c, {
          tenantId: actor.tenantId,
          difusionId: id,
          actor: actor.userId,
          actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
          requestId: request.requestId,
        }),
      );
    } catch (err) {
      if (err instanceof DifusionError) {
        throw new BadRequestException({ code: 'DIFUSION_RECHAZADA', message: err.message });
      }
      throw err;
    }
  }
}
