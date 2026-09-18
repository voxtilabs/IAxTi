import {
  Controller,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import { createQueue, redisConnection } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import { findAccountById, getProvider, tenantDeCuenta } from '@iaxti/module-channels';
import { normalizeQualityUpdates, normalizeStatuses } from '@iaxti/module-whatsapp';
import { apiPool } from './db';
import type { WithRequestId } from './request-id';

// El webhook base (#41, SPEC §12): verifica FIRMA sobre el cuerpo crudo,
// encola en `inbound` y responde en menos de un segundo. La idempotencia
// por id de mensaje del proveedor es el jobId de BullMQ: el duplicado ni
// entra a la cola. Ruta PÚBLICA fuera de /v1 (la firma es la autenticación).

// redisConnection() cae a localhost en desarrollo (docker compose);
// staging y prod siempre traen REDIS_URL.
let cola: ReturnType<typeof createQueue> | null = null;
function inboundQueue(): ReturnType<typeof createQueue> {
  cola ??= createQueue('inbound', redisConnection());
  return cola;
}

@ApiTags('webhooks')
@Controller('webhooks/channels')
export class WebhooksController {
  @Post(':accountId')
  @ApiOperation({ summary: 'Webhook de canal: firma, cola y 200 al tiro' })
  async recibir(
    @Req() request: RawBodyRequest<WithRequestId>,
    @Param('accountId') accountId: string,
  ) {
    const pool = apiPool();
    if (!pool) {
      throw new ServiceUnavailableException({
        code: 'DB_NOT_CONFIGURED',
        message: 'El servidor aún no tiene base de datos configurada. Intenta más tarde.',
      });
    }
    // El webhook llega SIN tenant: primero se averigua de quién es la cuenta
    // (función acotada, #286) y recién después se lee bajo su contexto. Antes
    // se leía con el pool pelado, y con el rol de producción eso devuelve
    // cero filas: TODO mensaje entrante habría respondido "Nada por aquí".
    const tenantId = await tenantDeCuenta(pool, accountId);
    const account = tenantId
      ? await withTenant(pool, tenantId, (c) => findAccountById(c, accountId))
      : null;
    // Cuenta inexistente y firma mala responden IGUAL: nada que sondear.
    if (!account || account.state === 'disconnected') {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Nada por aquí.' });
    }
    const provider = getProvider(account.kind);
    if (!provider) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Nada por aquí.' });
    }
    const secret = account.webhookSecretRef ? process.env[account.webhookSecretRef] : undefined;
    const rawBody = request.rawBody?.toString('utf8') ?? '';
    if (!secret || !provider.verifyWebhook(request.headers, rawBody, secret)) {
      throw new UnauthorizedException({
        code: 'INVALID_SIGNATURE',
        message: 'La firma del webhook no calza.',
      });
    }

    const mensajes = provider.normalize(
      (request as unknown as { body: unknown }).body,
    );
    const queue = inboundQueue();
    // Estados de entrega (#43): sent/delivered/read/failed del proveedor. Los
    // tres canales de Zavu comparten envelope, así que comparten estados.
    const CANALES_ZAVU = ['whatsapp', 'instagram', 'messenger'];
    const statuses = CANALES_ZAVU.includes(account.kind)
      ? normalizeStatuses((request as unknown as { body: unknown }).body)
      : [];
    if (statuses.length > 0) {
      const primer = statuses[0];
      await queue.add(
        'delivery-status',
        {
          moduleId: 'conversations',
          tenantId: account.tenantId,
          statuses,
          requestId: request.requestId,
        },
        { jobId: `st-${account.id}-${primer.providerMessageId}-${primer.status}-${statuses.length}` },
      );
    }
    // Calidad del número (#45): rating y límite de Meta.
    const quality = account.kind === 'whatsapp'
      ? normalizeQualityUpdates((request as unknown as { body: unknown }).body)
      : [];
    if (quality.length > 0) {
      await queue.add(
        'quality-update',
        {
          moduleId: 'whatsapp',
          tenantId: account.tenantId,
          updates: quality,
          requestId: request.requestId,
        },
        { jobId: `q-${account.id}-${quality[0].phoneNumberId}-${quality[0].quality ?? quality[0].messagingLimit}` },
      );
    }
    let queued = 0;
    for (const m of mensajes) {
      // jobId = idempotencia: BullMQ ignora un add con id repetido.
      await queue.add(
        'webhook',
        {
          moduleId: 'conversations',
          tenantId: account.tenantId,
          channelAccountId: account.id,
          channel: account.kind,
          phone: m.phone,
          type: m.type,
          body: m.body,
          attachments: m.attachments,
          providerMessageId: m.providerMessageId,
          requestId: request.requestId,
        },
        { jobId: `in-${account.id}-${m.providerMessageId}` },
      );
      queued++;
    }
    return { received: queued, statuses: statuses.length };
  }
}
