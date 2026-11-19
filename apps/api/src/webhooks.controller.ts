import { resolveChannelWebhookSecret } from '@iaxti/module-whatsapp';
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
  anotarEntrantesSinTelefono,
  anotarWebhook,
  findAccountById,
  proveedorDe,
  tenantDeCuenta,
  type ResultadoDeWebhook,
} from '@iaxti/module-channels';
import type { Pool } from 'pg';
import { entrantesSinTelefono, eventoDeZernioEsDeLaCuenta } from '@iaxti/module-whatsapp';
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
    const secretDeadline=Date.now()+800;
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
    if (!account) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Nada por aquí.' });
    }
    // Zernio puede entregar entre habilitar su webhook y confirmar active local.
    // Todavía no existe una referencia visible/confirmada: no atribuirlo a
    // firma inválida (401 no promete reentrega), ni aceptar el mensaje.
    if(account.state==='connecting') {
      // Se ANOTA antes de rechazar (#1180): si no, el canal a medio conectar
      // rechaza todo sin dejar huella, y el diagnóstico concluye «nunca llegó
      // un webhook» y manda a cambiar la URL del proveedor, que está bien.
      await anotar(account.tenantId, account.id, 'conexion_sin_confirmar');
      response.setHeader('Retry-After','5');
      throw new ServiceUnavailableException({code:'WEBHOOK_NOT_READY',message:'La conexión aún se está confirmando. Reintenta la entrega.'});
    }
    // El de la cuenta que recibe (ADR-0032): la firma se verifica con el
    // proveedor que la atiende, no con el que esté registrado para el canal.
    const provider = proveedorDe(account);
    if (!provider) {
      await anotar(account.tenantId, account.id, 'sin_proveedor');
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Nada por aquí.' });
    }
    let secret: string | undefined;
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      secret=await Promise.race([
        resolveChannelWebhookSecret(account,undefined,abort.signal),
        new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new Error('custody timeout'));},Math.max(1,secretDeadline-Date.now()));timer.unref?.();}),
      ]);
    } catch {
      response.setHeader('Retry-After','5');
      throw new ServiceUnavailableException({code:'WEBHOOK_SECRET_UNAVAILABLE',message:'No pudimos verificar esta entrega. Reintenta más tarde.'});
    } finally {if(timer)clearTimeout(timer);}
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
    const esZernio = account.provider === 'zernio';
    if (esZernio) {
      /**
       * La firma prueba que el evento es de Zernio; esto, que es de ESTA
       * cuenta y de ESTE negocio (#1321). Zernio ya entrega a esta URL solo
       * lo de su perfil y su cuenta (la suscripción está atada a los dos),
       * pero esa es SU barrera: esta es la nuestra, y se mira en cada evento.
       * Un evento ajeno con la firma buena es un webhook mal atado, no un
       * secreto malo, y se anota aparte para que el diagnóstico lo distinga.
       */
      const veredicto = eventoDeZernioEsDeLaCuenta(request.body, account);
      if (!veredicto.ok && veredicto.prueba) {
        // La muestra de `POST /v1/webhooks/test`: URL y secreto están bien, y
        // es todo lo que dice. No trae un mensaje que encolar.
        await anotar(account.tenantId, account.id, 'aceptado');
        return { received: 0, statuses: 0 };
      }
      if (!veredicto.ok) {
        console.warn(`webhook: evento de Zernio rechazado en la cuenta ${account.id}: ${veredicto.motivo}`);
        await anotar(account.tenantId, account.id, 'perfil_ajeno');
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Nada por aquí.' });
      }
    }
    // La suscripción de Zernio es de UNA cuenta: lo autenticado es lo
    // recibido. (El sobre de Zavu podía elegir otro canal del mismo emisor;
    // ese camino se fue con Zavu, #1339.)
    if (account.state === 'disconnected') {
      await anotar(account.tenantId, account.id, 'cuenta_desconectada');
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Nada por aquí.' });
    }
    await anotar(account.tenantId, account.id, 'aceptado');
    if (esZernio) {
      // Un mensaje sin teléfono no entra a la bandeja (#1331), pero tampoco se
      // pierde en silencio: se cuenta, y el diagnóstico lo dice. Se acepta el
      // webhook igual — reintentarlo no le va a poner un número.
      const sinTelefono = entrantesSinTelefono(request.body);
      if (sinTelefono > 0) {
        console.warn(`webhook: ${sinTelefono} mensaje(s) sin teléfono en la cuenta ${account.id}; no entran a la bandeja (#1331)`);
        const { tenantId, id } = account;
        await withTenant(pool, tenantId, (c) =>
          anotarEntrantesSinTelefono(c, { tenantId, accountId: id, cuantos: sinTelefono }),
        ).catch((error: Error) => console.warn(`webhook: no se pudo anotar el mensaje sin teléfono: ${error.message}`));
      }
    }

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
    // Estados de entrega (#43) y calidad del número (#45): Zernio todavía no
    // publica ninguno de los dos eventos. Cuando los publique, es acá donde
    // se encolan — el freno por calidad roja queda listo en
    // `applyQualityUpdate` (módulo whatsapp) y el eco de estados en el worker
    // de conversaciones.
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
          // El hilo del proveedor (ADR-0033): el worker de entrada lo recuerda
          // para que la respuesta salga dentro de esa conversación.
          ...(m.providerThreadId ? { providerThreadId: m.providerThreadId } : {}),
          requestId: request.requestId,
        },
        { jobId: `in-${account.id}-${m.providerMessageId}` },
      ));
      queued++;
    }
    return { received: queued, statuses: 0 };
  }
}
