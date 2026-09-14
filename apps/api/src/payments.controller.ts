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
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createQueue, redisConnection } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import {
  addProvider,
  cancelLink,
  createPaymentLink,
  findProviderGlobal,
  listLinks,
  listProviders,
  markLinkSent,
  paymentProviderFor,
  type ProviderKind,
} from '@iaxti/module-payments';
import { getConversation, sendMessage, updateDeliveryStatus } from '@iaxti/module-conversations';
import { getTenantSettings } from '@iaxti/module-organizations';
import { RequireModule, RequirePermission } from './authz/decorators';
import { actorCan } from './authz/can';
import type { Actor, WithUser } from './authz/authz.guard';
import type { WithRequestId } from './request-id';
import { apiPool } from './db';

// payments (#60/#61, SPEC §17): "cobra con links de pago desde el chat".
// El webhook es PÚBLICO (fuera de /v1): la firma es la autenticación, y
// encola — nunca procesa en línea.

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

function actorOf(request: WithUser): Actor {
  return request.actor as Actor;
}

let colaInbound: ReturnType<typeof createQueue> | null = null;
function inboundQueue(): ReturnType<typeof createQueue> {
  colaInbound ??= createQueue('inbound', redisConnection());
  return colaInbound;
}
let colaOutbound: ReturnType<typeof createQueue> | null = null;
function outboundQueue(): ReturnType<typeof createQueue> {
  colaOutbound ??= createQueue('outbound', redisConnection());
  return colaOutbound;
}

const KINDS: ProviderKind[] = ['flow', 'webpay', 'mercadopago', 'simulado'];

@ApiTags('payments')
@Controller('payments')
@RequireModule('payments')
export class PaymentsController {
  @Get('providers')
  @RequirePermission('payments.manage_providers')
  @ApiOperation({ summary: 'Los proveedores de pago del tenant' })
  async providers(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => listProviders(c, actor.tenantId));
  }

  @Post('providers')
  @RequirePermission('payments.manage_providers')
  @ApiOperation({ summary: 'Conecta un proveedor (credenciales POR REFERENCIA)' })
  async addProvider(
    @Req() request: WithUser,
    @Body()
    body: { kind?: string; name?: string; credentialRef?: string; webhookSecretRef?: string; mode?: string },
  ) {
    const actor = actorOf(request);
    if (!KINDS.includes(body?.kind as ProviderKind)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `El proveedor es uno de: ${KINDS.join(', ')}.`,
        details: [{ field: 'kind' }],
      });
    }
    if (body.mode === 'live' && (process.env.IAXTI_ENV ?? 'dev') !== 'production') {
      // SPEC §17: nunca credenciales reales fuera de producción.
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'En este ambiente los proveedores van SIEMPRE en modo test.',
        details: [{ field: 'mode' }],
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        return await addProvider(c, {
          tenantId: actor.tenantId,
          kind: body.kind as ProviderKind,
          name: body.name ?? '',
          credentialRef: body.credentialRef ?? '',
          webhookSecretRef: body.webhookSecretRef,
          mode: (body.mode as 'test' | 'live') ?? 'test',
          actor: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'PROVIDER_INVALID', message: (err as Error).message });
      }
    });
  }

  @Get('links')
  @RequirePermission('payments.read')
  @ApiOperation({ summary: 'Los links del tenant (filtrables por conversación u oportunidad)' })
  async links(
    @Req() request: WithUser,
    @Query('conversationId') conversationId?: string,
    @Query('dealId') dealId?: string,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) =>
      listLinks(c, actor.tenantId, { conversationId, dealId }),
    );
  }

  @Post('links')
  @RequirePermission('payments.create_link')
  @ApiOperation({ summary: 'Crea el link (monto de la oportunidad o escrito) y lo manda al chat' })
  async createLink(
    @Req() request: WithUser,
    @Body()
    body: {
      conversationId?: string;
      dealId?: string;
      amountClp?: number;
      concept?: string;
      providerId?: string;
      expiresHours?: number;
    },
  ) {
    const actor = actorOf(request);
    if (!body?.conversationId && !body?.dealId) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'El link nace de una conversación o de una oportunidad.',
      });
    }
    return withTenant(pool(), actor.tenantId, async (c) => {
      // El tope del USER (matriz §23) vive en settings.pagos.maxLinkClpUser;
      // quien puede administrar proveedores no tiene tope.
      const settings = (await getTenantSettings(c, actor.tenantId)) as {
        pagos?: { maxLinkClpUser?: number };
      };
      const sinTope = actorCan(actor, 'payments.manage_providers') || actor.role === 'SUPERVISOR';
      const tope = sinTope ? null : settings.pagos?.maxLinkClpUser ?? null;

      let contactId: string;
      let conversation: Awaited<ReturnType<typeof getConversation>> | null = null;
      if (body.conversationId) {
        conversation = await getConversation(c, actor.tenantId, body.conversationId).catch(() => {
          throw new NotFoundException({
            code: 'CONVERSATION_NOT_FOUND',
            message: 'No encontramos esa conversación. Puede que se haya archivado.',
          });
        });
        contactId = conversation.contactId;
      } else {
        const deal = await c.query('SELECT contact_id FROM deals WHERE tenant_id = $1 AND id = $2', [
          actor.tenantId,
          body.dealId,
        ]);
        if (deal.rowCount === 0) {
          throw new NotFoundException({ code: 'DEAL_NOT_FOUND', message: 'No encontramos esa oportunidad.' });
        }
        contactId = deal.rows[0].contact_id;
      }

      let link;
      try {
        link = await createPaymentLink(c, {
          tenantId: actor.tenantId,
          contactId,
          conversationId: body.conversationId,
          dealId: body.dealId,
          amountClp: body.amountClp ?? null,
          concept: body.concept ?? '',
          providerId: body.providerId,
          expiresHours: body.expiresHours,
          maxAmountClp: tope,
          actorUserId: actor.userId,
          requestId: request.requestId,
        });
      } catch (err) {
        throw new BadRequestException({ code: 'LINK_INVALID', message: (err as Error).message });
      }

      // Al chat de una: el link como mensaje del vendedor (montos en mono
      // los pone la UI; aquí va el texto que ve el cliente).
      if (conversation && link.url) {
        const message = await sendMessage(c, {
          tenantId: actor.tenantId,
          conversationId: conversation.id,
          authorKind: 'user',
          authorId: actor.userId,
          type: 'texto',
          body: `Te dejo el link de pago por "${link.concept}" — $${link.amountClp.toLocaleString('es-CL')}:\n${link.url}`,
          requestId: request.requestId,
        });
        if (conversation.channel === 'whatsapp') {
          await outboundQueue().add(
            'send',
            { moduleId: 'whatsapp', tenantId: actor.tenantId, messageId: message.id, requestId: request.requestId },
            { jobId: `out-${message.id}` },
          );
        } else {
          await updateDeliveryStatus(c, {
            tenantId: actor.tenantId,
            messageId: message.id,
            status: 'sent',
            requestId: request.requestId,
          });
        }
        await markLinkSent(c, { tenantId: actor.tenantId, linkId: link.id, requestId: request.requestId });
        return { ...link, status: 'sent' as const };
      }
      return link;
    });
  }

  @Post('links/:id/cancel')
  @RequirePermission('payments.create_link')
  @ApiOperation({ summary: 'Cancela un link no pagado' })
  async cancel(@Req() request: WithUser, @Param('id') id: string) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        await cancelLink(c, { tenantId: actor.tenantId, linkId: id, actor: actor.userId });
        return { cancelled: true };
      } catch (err) {
        throw new BadRequestException({ code: 'LINK_INVALID', message: (err as Error).message });
      }
    });
  }
}

/** El webhook PÚBLICO (#61): firma sobre el crudo, encola, 200 al tiro. */
@ApiTags('webhooks')
@Controller('webhooks/payments')
export class PaymentWebhooksController {
  @Post(':providerId')
  @ApiOperation({ summary: 'Webhook del proveedor de pagos: firma, cola y 200' })
  async recibir(
    @Req() request: RawBodyRequest<WithRequestId>,
    @Param('providerId') providerId: string,
  ) {
    const p = apiPool();
    if (!p) {
      throw new ServiceUnavailableException({
        code: 'DB_NOT_CONFIGURED',
        message: 'El servidor aún no tiene base de datos configurada. Intenta más tarde.',
      });
    }
    const client = await p.connect();
    let provider;
    try {
      provider = await findProviderGlobal(client, providerId);
    } finally {
      client.release();
    }
    // Proveedor inexistente y firma mala responden IGUAL: nada que sondear.
    if (!provider || !provider.active) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Nada por aquí.' });
    }
    const secret = provider.webhookSecretRef ? process.env[provider.webhookSecretRef] : undefined;
    const rawBody = request.rawBody?.toString('utf8') ?? '';
    const port = paymentProviderFor(provider.kind);
    if (
      !secret ||
      !port.verifyWebhook(rawBody, request.headers as Record<string, string>, secret)
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_SIGNATURE',
        message: 'La firma del webhook no calza.',
      });
    }
    const pago = port.parseWebhook(rawBody);
    if (!pago) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'El webhook no se entendió.' });
    }
    // Encola, no procesa en línea (SPEC §17). Idempotencia doble: jobId
    // por link+intento y el UNIQUE de payments en la confirmación.
    await inboundQueue().add(
      'payment-webhook',
      {
        moduleId: 'payments',
        tenantId: provider.tenantId,
        providerId: provider.id,
        providerKind: provider.kind,
        pago,
        requestId: request.requestId,
      },
      { jobId: `pay-${provider.id}-${pago.linkId || pago.providerPaymentId}` },
    );
    return { queued: true };
  }
}
