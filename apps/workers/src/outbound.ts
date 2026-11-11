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
  salientesDelDia,
  updateDeliveryStatus,
} from '@iaxti/module-conversations';
import { getTenant, getTenantSettings, puedeEnviar } from '@iaxti/module-organizations';
import {
  cupoDelDia,
  findAccountById,
  hayMargenParaUnAutomatismo,
  avisarDelCupoUnaVezAlDia,
  msHastaElReinicioDelCupo,
  hiloDe,
  olvidarHilo,
  recordarHilo,
  tomarCandadoDelHilo,
} from '@iaxti/module-channels';
import { canReceiveBusinessInitiated } from '@iaxti/module-crm';
import {
  RateLimitedError,
  causaLegible,
  esPermanente,
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
      /*
       * El cupo del día, con margen reservado para las personas (#1248).
       *
       * Medido el 3 de noviembre: el pulso del evento gastó 182 mensajes
       * sobre 91 entrantes y al cerrar el stand los 31 de despedida fallaron
       * todos. El tope es del canal entero —ni un mensaje de servicio dentro
       * de la ventana de 24 h pasa—, así que lo que escribe solo le quitó el
       * espacio al mensaje que una persona quería mandar.
       *
       * Va ACÁ, junto al silencio, porque este es el único lugar por donde
       * pasa todo lo que sale, y con la misma herramienta: se difiere, no se
       * rechaza. Un automatismo diferido sale al día siguiente, que es
       * exactamente lo que el mensaje del pulso podía esperar y el de
       * despedida no.
       *
       * Lo transaccional NO exime esto, al revés que el silencio: el tope lo
       * pone el proveedor y no nos lo salta ningún criterio nuestro. Lo que
       * cambia es que acá todavía queda cupo —el reservado— y el comprobante
       * de un pago lo manda el cliente al actuar, así que entra por el camino
       * de las personas. Un automatismo que no es transaccional espera.
       */
      const cupo = cupoDelDia({
        enviados: await salientesDelDia(client, {
          tenantId: data.tenantId,
          channelAccountId: ctx.channelAccountId,
        }),
        config: account.config as Record<string, unknown>,
      });
      if (!data.transaccional && !hayMargenParaUnAutomatismo(cupo)) {
        console.warn(
          `[${data.requestId ?? 'sin-request'}] cupo del canal: ${cupo.enviados}/${cupo.tope} ` +
            `usados${cupo.topeAsumido ? ' (tope asumido)' : ''}; quedan ${cupo.quedan} y ` +
            `${cupo.reserva} están reservados para lo que mande una persona. Se difiere a mañana.`,
        );
        /*
         * Y que el dueño se entere (#1248).
         *
         * El primer defecto del evento fue justamente este: el cupo se gastó a
         * lo largo de seis horas y el producto no dijo nada. El dueño se enteró
         * cuando lo importante —el mensaje de cierre— no salió.
         *
         * `marcarAvisoDeCupo` es un cerrojo, no una comprobación: con el cupo
         * agotado hay muchos jobs en la cola y cada uno querría avisar.
         * Cincuenta avisos iguales no son cincuenta veces más útiles que uno:
         * son una campana que el dueño silencia, y entonces el aviso que
         * importa tampoco llega.
         *
         * Se avisa cuando el cupo entra en la RESERVA, no cuando se agota del
         * todo. En ese momento todavía le quedan los 50 de las personas, así
         * que el aviso sirve para decidir —mandar lo importante ahora— y no
         * solo para explicar lo que ya no se pudo.
         */
        await avisarDelCupoUnaVezAlDia(client, {
          tenantId: data.tenantId,
          accountId: account.id,
          cupo,
          ...(data.requestId ? { requestId: data.requestId } : {}),
        });
        throw new DelayUntilError(msHastaElReinicioDelCupo());
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

    /*
     * El hilo del proveedor (ADR-0033, #1334). Para Zernio es la conversación
     * dentro de la que se manda; Zavu lo ignora.
     *
     * El candado va ANTES de leer el hilo y se suelta con la transacción, que
     * es después de recordar el nuevo: crear una conversación en Zernio no
     * acepta Idempotency-Key, y dos envíos simultáneos al mismo contacto sin
     * hilo conocido crearían dos y le mandarían la plantilla dos veces.
     */
    const claveDelHilo = { tenantId: data.tenantId, cuentaId: account.id, peer: ctx.phone };
    await tomarCandadoDelHilo(client, claveDelHilo);
    const hiloConocido = await hiloDe(client, claveDelHilo);
    const enviar = (hilo: string | null) =>
      deliverOutbound(
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
          ...(hilo ? { providerThreadId: hilo } : {}),
        },
        redis,
      );

    let res: { providerMessageId: string; providerThreadId?: string };
    try {
      try {
        res = await enviar(hiloConocido);
      } catch (err) {
        // El proveedor ya no tiene ese hilo (404 → `hilo_vencido`): se olvida
        // y se reintenta UNA vez, sin hilo. Una sola: si vuelve a fallar es
        // otra cosa, y tiene que verse en vez de quedar dando vueltas.
        if (hiloConocido && esPermanente(err) && err.detalle?.startsWith('hilo_vencido')) {
          await olvidarHilo(client, claveDelHilo);
          res = await enviar(null);
        } else {
          throw err;
        }
      }
      // Si el adaptador tuvo que abrir la conversación, se recuerda acá,
      // todavía bajo el candado.
      if (res.providerThreadId && res.providerThreadId !== hiloConocido) {
        await recordarHilo(client, { ...claveDelHilo, hilo: res.providerThreadId });
      }
    } catch (err) {
      // Lo que no se arregla reintentando se rechaza YA (#556). Antes todo lo
      // que no fuera rate limit se reencolaba, así que una credencial ausente
      // o un emisor sin asignar dejaban el mensaje «enviando» varias horas
      // antes de contar qué pasaba — y lo que contaba era el texto crudo del
      // sistema. Un canal mal conectado se arregla; para eso hay que nombrarlo.
      if (esPermanente(err)) {
        // El cuerpo del proveedor va al log y no a la bandeja: sirve para
        // depurar, no para quien está atendiendo a un cliente.
        if (err.detalle) console.error(`outbound ${data.messageId}: ${err.detalle}`);
        return rechazar(err.message);
      }
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

/**
 * Lo poco que hace falta del job para cerrar el mensaje que quedó colgado.
 *
 * Suelto a propósito: el evento `failed` de la cola entrega cualquier job de la
 * cola outbound, y su `data` es un dato que viene de Redis, no algo que este
 * proceso acabe de escribir. Se valida abajo antes de tocar la base.
 */
export interface JobDeSalidaAbandonado {
  data: Record<string, unknown>;
  attemptsMade: number;
  opts: { attempts?: number };
  /** BullMQ lo pone SOLO cuando ya decidió que no reintenta más. */
  finishedOn?: number;
}

/**
 * ¿La cola se dio por vencida con este job, o todavía va a reintentar?
 *
 * `finishedOn` es la señal directa: BullMQ lo escribe únicamente cuando mueve
 * el job a `failed` de verdad. El contador es el respaldo, porque el evento
 * `failed` se emite en CADA intento y marcar el mensaje en el primero sería
 * mentir — la cola todavía lo va a mandar.
 */
export function seDioPorVencida(job: JobDeSalidaAbandonado): boolean {
  const maxIntentos = job.opts.attempts ?? 1;
  return job.finishedOn !== undefined || job.attemptsMade >= maxIntentos;
}

/**
 * El mensaje que la cola abandonó deja de decir «enviando».
 *
 * `processOutbound` marca `failed` en los caminos que conoce —el proveedor
 * rechazó, la causa es permanente, se agotaron los intentos contra el
 * proveedor—, pero nadie marcaba nada cuando el job se caía POR FUERA de ese
 * `try`: un `RateLimitedError` en el último intento (se relanza siempre), la
 * base que no responde, R2 que no firma la URL del adjunto, la plantilla que no
 * se pudo leer. La fila se quedaba en `queued`, y «para siempre» es literal:
 * nada más vuelve a mirarla.
 *
 * El vendedor ve el mensaje «enviando» meses después, no sabe si el cliente lo
 * recibió, y lo único que puede hacer es escribirlo de nuevo — que duplica si
 * en realidad sí había salido.
 *
 * Idempotente y sin pisar nada: se relee la fila con el mismo bloqueo que usa
 * el despacho y solo se marca si sigue en `queued`. Un job que falló DESPUÉS de
 * que el proveedor aceptó ya está en `sent` y se deja como está.
 *
 * El motivo que lee la persona NO lleva el texto crudo del sistema: un
 * «ECONNREFUSED» no le dice a nadie qué hacer. El detalle va al log.
 */
export async function cerrarEnvioAbandonado(
  pool: Pool,
  job: JobDeSalidaAbandonado | undefined,
  err: unknown,
): Promise<{ marcado: boolean; motivo?: string }> {
  if (!job || !seDioPorVencida(job)) return { marcado: false };
  const { tenantId, messageId, requestId } = job.data;
  if (typeof tenantId !== 'string' || typeof messageId !== 'string') return { marcado: false };

  const causa =
    err instanceof RateLimitedError
      ? 'El canal estuvo con demasiados envíos en todos los intentos y no alcanzamos a mandarlo. Vuelve a intentarlo en un rato.'
      : 'No pudimos enviarlo después de varios intentos. Vuelve a intentarlo; si sigue igual, revisa la conexión del canal.';

  // El detalle sirve para depurar y va al log, nunca a la bandeja.
  console.error(
    `outbound ${messageId}: la cola se dio por vencida tras ${job.attemptsMade} intentos — ` +
      `${(err as Error | undefined)?.message ?? 'sin mensaje'}`,
  );

  try {
    return await withTenant(pool, tenantId, async (client) => {
      const ctx = await getOutboundContext(client, tenantId, messageId);
      // Ya terminó en otro estado (o el mensaje no existe): no hay nada que
      // cerrar, y forzarlo sería inventar un fallo sobre algo que sí salió.
      if (!ctx || ctx.deliveryStatus !== 'queued') return { marcado: false };
      await updateDeliveryStatus(client, {
        tenantId,
        messageId,
        status: 'failed',
        error: causa,
        ...(typeof requestId === 'string' ? { requestId } : {}),
      });
      return { marcado: true, motivo: causa };
    });
  } catch (fallo) {
    // Si ni esto se puede escribir, el mensaje sigue colgado — pero el proceso
    // no se cae por intentar avisar de otro fallo.
    console.error(
      `outbound ${messageId}: no pudimos marcar el envío abandonado — ${(fallo as Error).message}`,
    );
    return { marcado: false };
  }
}
