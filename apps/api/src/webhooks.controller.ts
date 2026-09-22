import {
  Controller,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import { createQueue, redisConnection } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import {
  anotarWebhook,
  findAccountById,
  getProvider,
  tenantDeCuenta,
  type ResultadoDeWebhook,
} from '@iaxti/module-channels';
import type { Pool } from 'pg';
import { normalizeQualityUpdates, normalizeStatuses } from '@iaxti/module-whatsapp';
import { apiPool } from './db';
import { conReintentoDeConexion, esFalloDeConexion } from './lib/arranque-en-frio';
import type { WithRequestId } from './request-id';
import type { Response } from 'express';

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

/**
 * Anota el resultado sin que el webhook dependa de ello.
 *
 * Es diagnóstico: si la anotación falla, el mensaje del cliente tiene que
 * entrar igual. Al revés sería cambiar una bandeja que funciona por una
 * columna que informa.
 */
async function anotarResultado(
  pool: Pool,
  tenantId: string,
  accountId: string,
  resultado: ResultadoDeWebhook,
): Promise<void> {
  await withTenant(pool, tenantId, (c) => anotarWebhook(c, { tenantId, accountId, resultado })).catch(
    (error: Error) => {
      console.warn(`webhook: no se pudo anotar el rastro del canal ${accountId}: ${error.message}`);
    },
  );
}

@ApiTags('webhooks')
@Controller('webhooks/channels')
export class WebhooksController {
  @Post(':accountId')
  @ApiOperation({ summary: 'Webhook de canal: firma, cola y 200 al tiro' })
  async recibir(
    @Req() request: RawBodyRequest<WithRequestId>,
    @Param('accountId') accountId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const pool = apiPool();
    const anotar = (tenantId: string, accountId: string, resultado: ResultadoDeWebhook) =>
      anotarResultado(pool!, tenantId, accountId, resultado);
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
    //
    // Y se hace CON REINTENTO (#361): la primera conexión al pooler después
    // de un despliegue a veces pasa el timeout, y eso respondía 500. Un 500
    // le dice al proveedor "me rompí"; algunos reintentan y otros no, y un
    // mensaje de cliente desaparece porque el contenedor llevaba cuarenta
    // segundos vivo.
    const cuenta = await conReintentoDeConexion(
      async () => {
        const tenantId = await tenantDeCuenta(pool, accountId);
        return tenantId
          ? await withTenant(pool, tenantId, (c) => findAccountById(c, accountId))
          : null;
      },
      {
        avisar: (error) =>
          console.warn(
            'webhook: la base no respondió a la primera y se reintentó. ' +
              'Si esto sale en cada despliegue, el pooler está tardando en despertar. ' +
              `Detalle: ${(error as Error).message}`,
          ),
      },
    ).catch((error: unknown) => {
      if (!esFalloDeConexion(error)) throw error;
      // 503 + Retry-After: lo que un proveedor sí sabe reintentar. Decirle
      // "vuelve en cinco segundos" conserva el mensaje; decirle 500 lo
      // deja a su criterio.
      response.setHeader('Retry-After', '5');
      throw new ServiceUnavailableException({
        code: 'BASE_NO_RESPONDE',
        message: 'No pudimos atender este webhook ahora. Reintenta en unos segundos.',
      });
    });
    const account = cuenta;
    // Cuenta inexistente y firma mala responden IGUAL: nada que sondear.
    if (!account || account.state === 'disconnected') {
      // Si la cuenta EXISTE pero está desconectada, queda anotado: es la
      // diferencia entre "el proveedor nos dejó de mandar" y "seguimos
      // recibiendo y los estamos botando nosotros".
      if (account) await anotar(account.tenantId, account.id, 'cuenta_desconectada');
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Nada por aquí.' });
    }
    const provider = getProvider(account.kind);
    if (!provider) {
      await anotar(account.tenantId, account.id, 'sin_proveedor');
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Nada por aquí.' });
    }
    const secret = account.webhookSecretRef ? process.env[account.webhookSecretRef] : undefined;
    const rawBody = request.rawBody?.toString('utf8') ?? '';
    if (!secret || !provider.verifyWebhook(request.headers, rawBody, secret)) {
      // Se anota ANTES de rechazar, y por eso existe todo esto (#434): una
      // firma que no calza y un webhook que nunca llegó se ven idénticos
      // desde adentro —la bandeja vacía— y se arreglan en lugares
      // distintos. Sin el rastro, la única forma de distinguirlos era
      // entrar a mirar logs que la API de Dokploy no expone.
      await anotar(account.tenantId, account.id, secret ? 'firma_invalida' : 'sin_secreto');
      throw new UnauthorizedException({
        code: 'INVALID_SIGNATURE',
        message: 'La firma del webhook no calza.',
      });
    }
    await anotar(account.tenantId, account.id, 'aceptado');

    const mensajes = provider.normalize(
      (request as unknown as { body: unknown }).body,
    );
    const queue = inboundQueue();
    /**
     * Encolar tampoco puede terminar en 500 (#361).
     *
     * Si Redis no está, el mensaje NO quedó aceptado y hay que decirlo
     * como algo que se reintenta. Responder 500 acá es la misma pérdida
     * silenciosa por otra puerta.
     *
     * Y se puede reintentar entero sin miedo: el `jobId` es el id del
     * mensaje del proveedor, así que lo que alcanzó a entrar la primera
     * vez se ignora en la segunda. Un reintento parcial no duplica nada.
     */
    const encolar = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        response.setHeader('Retry-After', '5');
        throw new ServiceUnavailableException({
          code: 'COLA_NO_DISPONIBLE',
          message: 'No pudimos guardar este mensaje ahora. Reintenta en unos segundos.',
          details: [{ motivo: (error as Error).message }],
        });
      }
    };
    // Estados de entrega (#43): sent/delivered/read/failed del proveedor. Los
    // tres canales de Zavu comparten envelope, así que comparten estados.
    const CANALES_ZAVU = ['whatsapp', 'instagram', 'messenger'];
    const statuses = CANALES_ZAVU.includes(account.kind)
      ? normalizeStatuses((request as unknown as { body: unknown }).body)
      : [];
    if (statuses.length > 0) {
      const primer = statuses[0];
      await encolar(() => queue.add(
        'delivery-status',
        {
          moduleId: 'conversations',
          tenantId: account.tenantId,
          statuses,
          requestId: request.requestId,
        },
        { jobId: `st-${account.id}-${primer.providerMessageId}-${primer.status}-${statuses.length}` },
      ));
    }
    // Calidad del número (#45): rating y límite de Meta.
    const quality = account.kind === 'whatsapp'
      ? normalizeQualityUpdates((request as unknown as { body: unknown }).body)
      : [];
    if (quality.length > 0) {
      await encolar(() => queue.add(
        'quality-update',
        {
          moduleId: 'whatsapp',
          tenantId: account.tenantId,
          updates: quality,
          requestId: request.requestId,
        },
        { jobId: `q-${account.id}-${quality[0].phoneNumberId}-${quality[0].quality ?? quality[0].messagingLimit}` },
      ));
    }
    let queued = 0;
    for (const m of mensajes) {
      // jobId = idempotencia: BullMQ ignora un add con id repetido.
      await encolar(() => queue.add(
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
      ));
      queued++;
    }
    return { received: queued, statuses: statuses.length };
  }
}
