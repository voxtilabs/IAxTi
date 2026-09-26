import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
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
  tenantDeProveedor,
  listLinks,
  listProviders,
  markLinkSent,
  paymentProviderFor,
  type ProviderKind,
} from '@iaxti/module-payments';
import { getConversation, salePorProveedor, sendMessage, updateDeliveryStatus } from '@iaxti/module-conversations';
import { listPipelines } from '@iaxti/module-crm';
import { getTenantSettings, updateTenantSettings } from '@iaxti/module-organizations';
import { z } from 'zod';
import { RequireModule, RequirePermission } from './authz/decorators';
import { Cuerpo, validar } from './validar';
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

const KINDS: ProviderKind[] = ['flow', 'webpay', 'mercadopago', 'simulado'];

/**
 * Los esquemas de entrada (#524), al lado de sus rutas.
 *
 * El mensaje va escrito acá porque lo lee quien está cobrándole a un cliente,
 * no quien programa. Y al esquema van SOLO las comprobaciones que hoy
 * responden `VALIDATION_ERROR`: las que el caso de uso rechaza con su propio
 * código (`PROVIDER_INVALID`, `LINK_INVALID`) se quedan donde están, porque
 * zod da un solo `code` por esquema y cambiarlo movería el contrato.
 */
const NuevoProveedor = z.object({
  kind: z.enum(['flow', 'webpay', 'mercadopago', 'simulado'], {
    error: `El proveedor es uno de: ${KINDS.join(', ')}.`,
  }),
  // `name` y `credentialRef` NO se exigen acá aunque sean obligatorios: los
  // revisa `addProvider` con sus propios mensajes (que el nombre no venga
  // vacío, que la referencia sea el NOMBRE de la variable y no la
  // credencial) y responde `PROVIDER_INVALID`. Ese código es el que ya
  // conocen el SDK y la pantalla de Ajustes → Pagos.
  name: z.string().optional(),
  credentialRef: z.string().optional(),
  webhookSecretRef: z.string().optional(),
  // El modo llega como texto y el esquema no lo restringe: si 'live' se
  // puede o no depende del AMBIENTE, que el esquema no conoce —se declara
  // una vez al cargar el módulo— y el catálogo (#492) publicaría un 'mode'
  // que miente según dónde corra. Se comprueba en la ruta, abajo.
  mode: z.string().optional(),
});

const NuevoLinkDePago = z
  .object({
    conversationId: z.string().optional(),
    dealId: z.string().optional(),
    amountClp: z.number().optional(),
    concept: z.string().optional(),
    providerId: z.string().optional(),
    expiresHours: z.number().optional(),
  })
  // De dónde nace el link es cosa de DOS campos: ninguno es obligatorio por
  // su cuenta, pero uno tiene que venir. Por eso va como comprobación del
  // objeto y sin `path`: el error no era de un campo y sus `details` tampoco
  // lo nombraban.
  .refine((body) => Boolean(body.conversationId || body.dealId), {
    message: 'El link nace de una conversación o de una oportunidad.',
  });

/**
 * El tope de monto para quien cobra con límite (#535).
 *
 * `null` lo saca: un negocio que hoy no tiene tope no puede quedar con uno por
 * omisión, porque alguien que cobra $800.000 sin problema empezaría a recibir un
 * rechazo que nadie le explicó. El tope se activa cuando el negocio lo escribe.
 */
const AjustesDeCobro = z.object({
  maxLinkClpUser: z
    .number({ error: 'El tope va en pesos, como número.' })
    .int('El tope va en pesos enteros.')
    .min(1, 'El tope tiene que ser mayor que cero. Para quitarlo, déjalo vacío.')
    .nullable(),
  /**
   * La etapa a la que se mueve la oportunidad cuando el cliente paga (#536).
   *
   * Se leía en `confirm.ts` desde el principio y ninguna ruta la escribía, así
   * que el cliente pagaba, el comprobante se publicaba en la conversación y la
   * oportunidad se quedaba en «Propuesta» para siempre. El vendedor tenía que
   * moverla a mano y nada se lo recordaba, así que el dueño miraba el embudo y
   * veía plata «por cerrar» que ya estaba en su cuenta.
   *
   * `null` lo apaga: mover el deal es cortesía y hay negocios que prefieren
   * hacerlo a mano.
   */
  paidStageName: z.string().trim().min(1, 'Dinos el nombre de la etapa.').nullable().optional(),
});

@ApiTags('payments')
@Controller('payments')
@RequireModule('payments')
export class PaymentsController {
  /**
   * El tope de monto del vendedor (#535).
   *
   * `settings.pagos.maxLinkClpUser` se LEÍA desde el primer día —en la ruta de
   * crear el link— y ninguna ruta lo escribía: la única escritura del repo era
   * un `UPDATE` crudo en un test, que es justo por lo que el test pasaba y el
   * producto no. Así que el tope quedaba en null siempre y cualquier vendedor
   * con rol USER podía emitir un link por el monto que quisiera y mandarlo al
   * chat del cliente en el mismo click. La matriz §23 le promete al dueño que
   * «hasta tope» lo protege.
   */
  @Get('ajustes')
  @RequirePermission('tenant.settings')
  @ApiOperation({ summary: 'El tope de monto para quien cobra con límite' })
  async ajustes(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const settings = (await getTenantSettings(c, actor.tenantId)) as {
        pagos?: { maxLinkClpUser?: number; paidStageName?: string };
      };
      // Los nombres de etapa que existen, para que la pantalla ofrezca elegir en
      // vez de pedir que se escriba uno: un nombre que no calza con ninguna
      // etapa no mueve nada y no avisa (confirm.ts lo busca por nombre).
      const embudos = await listPipelines(c, actor.tenantId);
      return {
        maxLinkClpUser: settings.pagos?.maxLinkClpUser ?? null,
        paidStageName: settings.pagos?.paidStageName ?? null,
        etapasDisponibles: [
          ...new Set(embudos.flatMap((p) => p.stages.map((e) => e.name))),
        ].sort(),
      };
    });
  }

  @Put('ajustes')
  @RequirePermission('tenant.settings')
  @ApiOperation({ summary: 'Guarda el tope de monto para quien cobra con límite' })
  async guardarAjustes(@Req() request: WithUser, @Body() body: unknown) {
    const actor = actorOf(request);
    // `validar` suelto y no `@Cuerpo(...)`: el pipe convierte el cuerpo ausente
    // en `{}` y acá esa diferencia ES el 400 — un PUT sin cuerpo tiene que
    // decirlo, no responder 200 diciendo que guardó.
    const ajustes = validar(AjustesDeCobro, body);
    return withTenant(pool(), actor.tenantId, async (c) => {
      // Se mezcla DENTRO de `pagos`: `updateTenantSettings` hace `settings ||
      // patch`, que es merge de primer nivel, así que escribir `{ pagos: {...} }`
      // pisaría las otras claves de pagos (#536).
      const actuales = (await getTenantSettings(c, actor.tenantId)) as {
        pagos?: Record<string, unknown>;
      };
      const pagos = { ...(actuales.pagos ?? {}) };
      if (ajustes.maxLinkClpUser === null) delete pagos.maxLinkClpUser;
      else pagos.maxLinkClpUser = ajustes.maxLinkClpUser;

      // La etapa se valida contra las que EXISTEN (#536): `confirm.ts` la busca
      // por nombre y si no calza no mueve nada ni avisa. Un typo acá sería un
      // embudo que nunca se actualiza y nadie sabría por qué.
      let enEmbudos: string[] = [];
      let faltaEn: string[] = [];
      if (ajustes.paidStageName !== undefined) {
        if (ajustes.paidStageName === null) delete pagos.paidStageName;
        else {
          const embudos = await listPipelines(c, actor.tenantId);
          const buscado = ajustes.paidStageName.toLowerCase();
          enEmbudos = embudos.filter((p) => p.stages.some((e) => e.name.toLowerCase() === buscado)).map((p) => p.name);
          faltaEn = embudos.filter((p) => !p.stages.some((e) => e.name.toLowerCase() === buscado)).map((p) => p.name);
          if (enEmbudos.length === 0) {
            const nombres = [...new Set(embudos.flatMap((p) => p.stages.map((e) => e.name)))];
            throw new BadRequestException({
              code: 'ETAPA_DESCONOCIDA',
              message:
                `Ninguno de tus embudos tiene una etapa "${ajustes.paidStageName}". ` +
                (nombres.length
                  ? `Las que tienes: ${nombres.join(', ')}.`
                  : 'Todavía no tienes etapas: arma tu embudo primero.'),
              details: [{ field: 'paidStageName' }],
            });
          }
          pagos.paidStageName = ajustes.paidStageName;
        }
      }

      await updateTenantSettings(c, actor.tenantId, { pagos });
      return {
        maxLinkClpUser: ajustes.maxLinkClpUser,
        paidStageName: (pagos.paidStageName as string) ?? null,
        // Cuáles embudos van a mover la oportunidad y cuáles no: un negocio con
        // dos embudos y la etapa en uno solo merece saberlo al guardar, no
        // descubrirlo cuando el otro no se movió.
        enEmbudos,
        faltaEn,
      };
    });
  }

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
    @Cuerpo(NuevoProveedor) body: z.infer<typeof NuevoProveedor>,
  ) {
    const actor = actorOf(request);
    // El ambiente no es la forma del cuerpo, así que esto se queda como `if`
    // (ver el esquema). El caso de uso lo vuelve a comprobar (ADR-0008): la
    // regla es de él, no de esta puerta.
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
          kind: body.kind,
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
    @Cuerpo(NuevoLinkDePago) body: z.infer<typeof NuevoLinkDePago>,
  ) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, async (c) => {
      // El tope del USER (matriz §23) vive en settings.pagos.maxLinkClpUser;
      // quien puede administrar proveedores no tiene tope.
      const settings = (await getTenantSettings(c, actor.tenantId)) as {
        pagos?: { maxLinkClpUser?: number };
      };
      // ADR-0008: jamás condicionar por rol — el tope lo levanta un PERMISO.
      const sinTope = actorCan(actor, 'payments.create_link_unlimited');
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
          delivery: 'reply',
          actorKind: actor.kind === 'apikey' ? 'apikey' : 'user',
        });
        if (!salePorProveedor(conversation.channel)) {
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
        await cancelLink(c, {
          tenantId: actor.tenantId,
          linkId: id,
          actor: actor.userId,
          requestId: request.requestId,
        });
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
    // Igual que el webhook de canales (#286): el tenant se averigua primero
    // con la función acotada y el proveedor se lee bajo su contexto. Con el
    // pool pelado y el rol de producción, un pago confirmado por el proveedor
    // no se habría registrado nunca.
    const tenantId = await tenantDeProveedor(p, providerId);
    const provider = tenantId
      ? await withTenant(p, tenantId, (c) => findProviderGlobal(c, providerId))
      : null;
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
