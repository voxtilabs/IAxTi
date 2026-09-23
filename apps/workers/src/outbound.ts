import type { Pool } from 'pg';
import type IORedis from 'ioredis';
import type { Job } from 'bullmq';
import { withTenant } from '@iaxti/db';
import { presignUrl, storageFromEnv } from '@iaxti/core';
import {
  bandejaSettings,
  enSilencio,
  getOutboundContext,
  isWithinWindow,
  msHastaFinDeSilencio,
  updateDeliveryStatus,
} from '@iaxti/module-conversations';
import { getTenant, getTenantSettings, puedeEnviar } from '@iaxti/module-organizations';
import { findAccountById } from '@iaxti/module-channels';
import { canReceiveBusinessInitiated } from '@iaxti/module-crm';
import {
  RateLimitedError,
  causaLegible,
  deliverOutbound,
  isBusinessPaused,
  listTemplates,
  renderizar,
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

/**
 * De llaves privadas en R2 a URLs que el proveedor pueda bajar (#458).
 *
 * La firma dura poco a propósito: es un archivo de un cliente y no tiene
 * por qué quedar accesible en una URL eterna. Por eso se firma al
 * despachar y no al responder.
 */
async function adjuntosParaElProveedor(
  crudos: unknown[],
): Promise<Array<{ url: string; filename?: string; contentType?: string }>> {
  if (crudos.length === 0) return [];
  const storage = storageFromEnv();
  if (!storage) return [];
  const salida: Array<{ url: string; filename?: string; contentType?: string }> = [];
  for (const crudo of crudos) {
    const a = crudo as { key?: string; url?: string; filename?: string; contentType?: string };
    // Un adjunto que YA trae URL pública se manda tal cual: es el caso del
    // que llegó de afuera y todavía no se copió a R2.
    const url = a.key ? presignUrl(storage, 'GET', a.key) : a.url;
    if (!url) continue;
    salida.push({
      url,
      ...(a.filename ? { filename: a.filename } : {}),
      ...(a.contentType ? { contentType: a.contentType } : {}),
    });
  }
  return salida;
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
    // El contrato bloquea la fila hasta el commit. Una redelivery o dos
    // consumidores del mismo mensaje no vuelven a mandar lo ya confirmado.
    if (ctx.deliveryStatus !== 'queued') {
      return ctx.deliveryStatus === 'failed'
        ? { failed: 'El envío ya había fallado.' }
        : { providerMessageId: ctx.providerMessageId ?? undefined };
    }
    const rechazar = async (motivo: string) => {
      await updateDeliveryStatus(client, {
        tenantId: data.tenantId, messageId: data.messageId,
        status: 'failed', error: motivo, requestId: data.requestId,
      });
      return { failed: motivo };
    };
    if (!ctx.channelAccountId) {
      return rechazar('La conversación no tiene un canal conectado.');
    }

    // El estado del tenant manda (SPEC §6): en solo lectura por impago solo
    // salen respuestas manuales, y de una cuenta suspendida no sale nada.
    // Se comprueba ANTES que todo lo demás, y acá — este es el único lugar
    // por donde pasa TODO lo que sale.
    const tenant = await getTenant(client, data.tenantId);
    const permiso = puedeEnviar(tenant.state, data.initiatedByBusiness);
    if (!permiso.ok) {
      return rechazar(permiso.motivo);
    }

    if (ctx.optedOutAt || (data.initiatedByBusiness && !ctx.lastInboundAt &&
        !(await canReceiveBusinessInitiated(client, data.tenantId, ctx.contactId)))) {
      return rechazar('El contacto no tiene consentimiento vigente para recibir este mensaje.');
    }

    const account = await findAccountById(client, ctx.channelAccountId);
    // Calidad roja degrada la cuenta pero todavía permite respuestas
    // manuales; su pausa de negocio se evalúa más abajo.
    if (!account || account.tenantId !== data.tenantId || account.kind !== ctx.channel ||
        !['active', 'degraded'].includes(account.state)) {
      return rechazar('El canal de esta conversación no está activo. Revisa su conexión.');
    }

    if (ctx.type === 'plantilla') {
      const snapshot = ctx.extra?.plantilla as Record<string, unknown> | undefined;
      const aprobadas = ctx.channel === 'whatsapp'
        ? await listTemplates(client, data.tenantId, { status: 'approved' }) : [];
      const plantilla = aprobadas.find(t => t.id === snapshot?.id && t.name === snapshot.name &&
        t.language === snapshot.language && t.category === snapshot.category);
      let vigente = false;
      if (plantilla && Array.isArray(snapshot?.valores) && snapshot.valores.every(v => typeof v === 'string')) {
        try { vigente = renderizar(plantilla.body, snapshot.valores) === ctx.body; } catch { /* variables inválidas */ }
      }
      if (!vigente) return rechazar('La plantilla ya no coincide con una versión aprobada. Revisa la plantilla antes de enviar.');
    } else if (!isWithinWindow(ctx.channel, ctx.lastInboundAt)) {
      return rechazar('Pasaron más de 24 horas desde su último mensaje: la ventana del canal está cerrada.');
    }

    if (data.initiatedByBusiness) {
      // Calidad en rojo (#45): lo del negocio se pausa; reactivar es del ADMIN.
      // Esto NO lo exime lo transaccional: si Meta tiene el número castigado,
      // mandar más es empeorarlo. Se pierde el comprobante, no el número.
      const pausa = await isBusinessPaused(client, data.tenantId, ctx.channelAccountId);
      if (pausa) {
        return rechazar(pausa);
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

    /**
     * Los adjuntos, convertidos en algo que el proveedor pueda bajar (#458).
     *
     * En R2 la llave es privada: el proveedor no la puede leer. Se firma
     * acá, en el momento del despacho, y NO al responder — una URL firmada
     * al guardar el mensaje estaría vencida cuando el reintento del quinto
     * intento salga cuatro horas después.
     */
    const adjuntos = await adjuntosParaElProveedor(ctx.attachments);
    if (ctx.attachments.length > 0 && adjuntos.length === 0) {
      // Mandar el texto sin la foto sería peor que no mandar: el cliente
      // recibe "acá va la cotización" y no va nada.
      return rechazar('No pudimos preparar el adjunto para enviarlo. Revisa el almacenamiento.');
    }

    let res: { providerMessageId: string };
    try {
      res = await deliverOutbound(
        account,
        {
          ...data,
          to: ctx.phone,
          body: ctx.body ?? undefined,
          type: ctx.type,
          ...(adjuntos.length > 0 ? { attachments: adjuntos } : {}),
          // La plantilla viaja con el MENSAJE, no con el job: así un
          // reintento de la cola manda exactamente la misma (#44).
          extra: ctx.extra ?? undefined,
        },
        redis,
      );
    } catch (err) {
      if (err instanceof RateLimitedError || !esUltimoIntento) {
        throw err; // BullMQ reintenta con backoff exponencial
      }
      const causa = causaLegible(undefined, (err as Error).message);
      return rechazar(causa);
    }
    // Un fallo al guardar no es un rechazo del proveedor. Se propaga para
    // diagnóstico/reintento; no se oculta detrás de un failed inventado.
    await updateDeliveryStatus(client, {
      tenantId: data.tenantId, messageId: data.messageId, status: 'sent',
      providerMessageId: res.providerMessageId, requestId: data.requestId,
    });
    return { providerMessageId: res.providerMessageId };
  });
}
