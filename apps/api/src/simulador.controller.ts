import { Controller, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { createQueue, redisConnection } from '@iaxti/core';
import { RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo, textoRequerido } from './validar';
import type { WithUser } from './authz/authz.guard';

// El simulador de mensajes entrantes (#36): encola en la MISMA cola `inbound`
// que usará el canal real. Este controller solo se registra fuera de
// producción (ver app.module.ts): en prod la ruta no existe, ni siquiera 403.
let cola: ReturnType<typeof createQueue> | null = null;
function inboundQueue(): ReturnType<typeof createQueue> | null {
  if (!process.env.REDIS_URL) return null;
  cola ??= createQueue('inbound', redisConnection());
  return cola;
}

/**
 * El mensaje que se finge que llegó (#524).
 *
 * Solo el teléfono es obligatorio, igual que antes: lo demás tiene valor por
 * defecto al armar el job y se deja opcional acá para no inventar validaciones
 * que la ruta nunca hizo. `type` y `channel` NO son enum a propósito: la
 * gracia del simulador es probar lo que manda un canal, incluido un tipo que
 * el worker todavía no entiende.
 */
const EntranteSimulado = z.object({
  phone: textoRequerido('Falta el teléfono del contacto simulado.'),
  body: z.string().optional(),
  type: z.string().optional(),
  channel: z.string().optional(),
  providerMessageId: z.string().optional(),
});

@ApiTags('dev')
@Controller('dev')
export class SimuladorController {
  @Post('inbound')
  @RequireModule('conversations')
  @RequirePermission('conversations.reply')
  @ApiOperation({ summary: 'Simula un mensaje entrante (solo local y staging)' })
  async inbound(@Req() request: WithUser, @Cuerpo(EntranteSimulado) body: z.infer<typeof EntranteSimulado>) {
    const tenantId = (request as unknown as { headers: Record<string, string> }).headers[
      'x-tenant-id'
    ];
    const queue = inboundQueue();
    if (!queue) {
      throw new ServiceUnavailableException({
        code: 'QUEUE_NOT_CONFIGURED',
        message: 'El servidor aún no tiene colas configuradas. Intenta más tarde.',
      });
    }
    const job = await queue.add('simulado', {
      moduleId: 'conversations',
      tenantId,
      phone: body.phone,
      channel: body.channel ?? 'simulador',
      type: body.type ?? 'texto',
      body: body.body,
      providerMessageId: body.providerMessageId,
      requestId: (request as unknown as { requestId?: string }).requestId,
    });
    return { queued: true, jobId: job.id };
  }
}
