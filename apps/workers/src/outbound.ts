import type { Pool } from 'pg';
import type IORedis from 'ioredis';
import type { Job } from 'bullmq';
import { withTenant } from '@iaxti/db';
import {
  bandejaSettings,
  enSilencio,
  getOutboundContext,
  msHastaFinDeSilencio,
  updateDeliveryStatus,
} from '@iaxti/module-conversations';
import { getTenant, getTenantSettings, puedeEnviar } from '@iaxti/module-organizations';
import { findAccountById } from '@iaxti/module-channels';
import {
  RateLimitedError,
  causaLegible,
  deliverOutbound,
  isBusinessPaused,
  type OutboundJobData,
} from '@iaxti/module-whatsapp';

// La salida (#43): entrega por el adaptador, rate limit por número,
// reintento exponencial de BullMQ, y el fallo DEFINITIVO con causa legible
// en la bandeja. El silencio del tenant solo frena lo INICIADO por el
// negocio (plantillas/campañas); responderle a un cliente nunca espera.

export class DelayUntilError extends Error {
  constructor(public readonly ms: number) {
    super(`Reprogramado ${Math.round(ms / 60000)} min (horario de silencio).`);
  }
}

export async function processOutbound(
  pool: Pool,
  redis: IORedis,
  job: Pick<Job, 'attemptsMade' | 'opts'> & { data: OutboundJobData },
): Promise<{ providerMessageId?: string; failed?: string }> {
  const data = job.data;
  const maxAttempts = (job.opts.attempts ?? 5) as number;
  const esUltimoIntento = job.attemptsMade + 1 >= maxAttempts;

  return withTenant(pool, data.tenantId, async (client) => {
    const ctx = await getOutboundContext(client, data.tenantId, data.messageId);
    if (!ctx) return { failed: 'mensaje inexistente' };
    if (!ctx.channelAccountId) {
      await updateDeliveryStatus(client, {
        tenantId: data.tenantId,
        messageId: data.messageId,
        status: 'failed',
        error: 'La conversación no tiene un canal conectado.',
      }).catch(() => {});
      return { failed: 'sin canal' };
    }

    // El estado del tenant manda (SPEC §6): en solo lectura por impago solo
    // salen respuestas manuales, y de una cuenta suspendida no sale nada.
    // Se comprueba ANTES que todo lo demás, y acá — este es el único lugar
    // por donde pasa TODO lo que sale.
    const tenant = await getTenant(client, data.tenantId);
    const permiso = puedeEnviar(tenant.state, data.initiatedByBusiness);
    if (!permiso.ok) {
      await updateDeliveryStatus(client, {
        tenantId: data.tenantId,
        messageId: data.messageId,
        status: 'failed',
        error: permiso.motivo,
      }).catch(() => {});
      return { failed: permiso.motivo };
    }

    if (data.initiatedByBusiness) {
      // Calidad en rojo (#45): lo del negocio se pausa; reactivar es del ADMIN.
      // Esto NO lo exime lo transaccional: si Meta tiene el número castigado,
      // mandar más es empeorarlo. Se pierde el comprobante, no el número.
      const pausa = await isBusinessPaused(client, data.tenantId, ctx.channelAccountId);
      if (pausa) {
        await updateDeliveryStatus(client, {
          tenantId: data.tenantId,
          messageId: data.messageId,
          status: 'failed',
          error: pausa,
        }).catch(() => {});
        return { failed: pausa };
      }
      // El horario de silencio SÍ lo exime un mensaje transaccional
      // (ADR-0016): lo dispara el cliente al actuar —pagar— y es la
      // constancia de eso. Quien acaba de pagar está despierto, y un
      // comprobante que llega doce horas después ya no tranquiliza a nadie.
      if (!data.transaccional) {
        const settings = bandejaSettings(await getTenantSettings(client, data.tenantId));
        if (enSilencio(settings.silencio)) {
          throw new DelayUntilError(msHastaFinDeSilencio(settings.silencio));
        }
      }
    }

    const account = await findAccountById(client, ctx.channelAccountId);
    if (!account) return { failed: 'cuenta de canal inexistente' };

    try {
      const res = await deliverOutbound(
        account,
        {
          ...data,
          to: ctx.phone,
          body: ctx.body ?? undefined,
          type: ctx.type,
          // La plantilla viaja con el MENSAJE, no con el job: así un
          // reintento de la cola manda exactamente la misma (#44).
          ...(ctx.extra ? { extra: ctx.extra } : {}),
        },
        redis,
      );
      // sent + el wamid en el mensaje: el webhook de estados lo ubica por él.
      await updateDeliveryStatus(client, {
        tenantId: data.tenantId,
        messageId: data.messageId,
        status: 'sent',
        providerMessageId: res.providerMessageId,
        requestId: data.requestId,
      });
      return { providerMessageId: res.providerMessageId };
    } catch (err) {
      if (err instanceof RateLimitedError || !esUltimoIntento) {
        throw err; // BullMQ reintenta con backoff exponencial
      }
      const causa = causaLegible(undefined, (err as Error).message);
      await updateDeliveryStatus(client, {
        tenantId: data.tenantId,
        messageId: data.messageId,
        status: 'failed',
        error: causa,
        requestId: data.requestId,
      }).catch(() => {});
      return { failed: causa };
    }
  });
}
