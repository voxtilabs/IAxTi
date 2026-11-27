import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { storageFromEnv } from '@iaxti/core';
import { autoAssignNew, receiveInbound } from '@iaxti/module-conversations';
import type { Channel, MessageType } from '@iaxti/module-conversations';
import { handleInboundForConsent } from '@iaxti/module-crm';
import { findAccountById, recordarHilo } from '@iaxti/module-channels';
import {
  baseDeZernio,
  downloadAttachmentsToR2,
  type AdjuntoEntrante,
  credencialDeLaCuenta,
} from '@iaxti/module-whatsapp';

/**
 * El job de la cola `inbound` (SPEC §28): ESTE es el único camino de entrada
 * de mensajes. El simulador (#36) y los adaptadores reales de Fase 3 encolan
 * exactamente esta forma; el procesador no sabe quién lo llamó.
 */
export interface InboundJob {
  moduleId?: 'conversations';
  tenantId: string;
  phone: string;
  channel?: Channel;
  channelAccountId?: string;
  type?: MessageType;
  body?: string;
  attachments?: unknown[];
  providerMessageId?: string;
  /** El id de la conversación del lado del proveedor (ADR-0033). */
  providerThreadId?: string;
  requestId?: string;
}

export interface InboundOutcome {
  conversationId: string;
  messageId: string;
  contactId: string;
  contactCreated: boolean;
  conversationCreated: boolean;
  reopened: boolean;
  optedOut: boolean;
  /** Dueño puesto por la asignación automática del tenant (#38), si hubo. */
  assignedTo: string | null;
  /**
   * Los adjuntos COMO QUEDARON, con su `key` de R2 si se pudieron guardar (#1200).
   *
   * Existe porque `main.ts` encolaba la sugerencia leyendo `data.attachments`
   * —el job original, donde el adjunto todavía es `{url}` del proveedor— así
   * que `audioKey` era SIEMPRE undefined y ninguna nota de voz se transcribía
   * jamás. La fila de `messages` sí tenía la versión guardada, porque
   * `receiveInbound` recibe la local; el job no.
   */
  attachments: AdjuntoEntrante[] | undefined;
}

/**
 * El nombre de perfil del contacto (#1170) era una consulta a Zavu y se fue
 * con Zavu (#1339): el contacto queda con el nombre que le ponga el negocio.
 * El día que un proveedor expona el perfil de un contacto, el encolado se
 * agrega acá mismo — la decisión de con qué identidad buscar era del job, no
 * de la transacción del mensaje.
 */
export async function processInbound(
  pool: Pool,
  data: InboundJob,
): Promise<InboundOutcome> {
  if (!data.tenantId || !data.phone) {
    throw new Error('inbound: el job necesita tenantId y phone.');
  }
  const outcome = await withTenant(pool, data.tenantId, async (client) => {
    // Adjuntos (#42): las URLs del proveedor son firmadas y de vida corta — se
    // bajan AL LLEGAR y van a R2 por tenant; en el mensaje queda solo la llave
    // (carpeta whatsapp/ del tenant). Si la descarga falla, el mensaje entra
    // igual con la metadata original: perder el texto por un adjunto sería peor.
    // Tipado acá y no con tres aserciones repartidas abajo: desde #1200 este
    // valor SALE de la función, y un `unknown[]` que cruza la frontera obliga a
    // adivinarlo del otro lado.
    let attachments: AdjuntoEntrante[] | undefined = data.attachments as AdjuntoEntrante[] | undefined;
    const conMedia = attachments?.some((a) => a?.url);
    if (conMedia && data.channelAccountId) {
      try {
        const account = await findAccountById(client, data.channelAccountId);
        // Del entorno o de la custodia (#1393): un fallo de la custodia es
        // «sin llave», que abajo se dice en voz alta.
        const apiKey = account ? await credencialDeLaCuenta(account).catch(() => undefined) : undefined;
        const storage = storageFromEnv();
        // Por qué NO se baja, dicho en voz alta.
        //
        // Esto era `if (account && apiKey && storage)` y nada más: con
        // cualquiera de las tres en falso se caía por fuera del `if` sin una
        // línea de log —el `catch` solo salta si algo LANZA—, el mensaje se
        // guardaba con la URL firmada y de vida corta del proveedor, y esa URL
        // vence. O sea: el adjunto se perdía para siempre y el único rastro
        // era un enlace muerto.
        //
        // Las tres causas son distintas y se arreglan en lugares distintos:
        // una cuenta que ya no existe es un problema de datos, una credencial
        // ausente es del ambiente, y R2 sin configurar es del despliegue —y
        // esa última se la perdían TODOS los negocios a la vez (#809).
        const falta = !account
          ? `la cuenta de canal ${data.channelAccountId} no existe`
          : !apiKey
            ? 'la credencial del canal no está en este ambiente (el diagnóstico del canal dice cuál)'
            : !storage
              ? 'R2 no está configurado (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_ADJUNTOS)'
              : null;
        if (falta) {
          const cuantos = (attachments ?? []).filter((a) => a?.url).length;
          console.error(
            `inbound: ${cuantos} adjunto(s) del tenant ${data.tenantId} NO se guardaron y se van a ` +
              `perder cuando venza la URL del proveedor — ${falta}`,
          );
        } else if (account && apiKey && storage) {
          attachments = await downloadAttachmentsToR2({
            tenantId: data.tenantId,
            conversationId: 'whatsapp',
            attachments: attachments ?? [],
            apiKey,
            storage,
          }, {
            // La llave solo viaja al dominio del proveedor (#1335): la base es
            // la de Zernio, el único transporte de WhatsApp que queda (#1339).
            // Una URL fuera de ese dominio se baja sin llave — `llevaCredencial`
            // decide — y el simulador nunca manda URLs de verdad.
            apiBase: baseDeZernio(),
          });
        }
      } catch (err) {
        console.error('inbound: adjunto no descargado —', (err as Error).message);
      }
    }
    const res = await receiveInbound(client, {
      tenantId: data.tenantId,
      phone: data.phone,
      channel: data.channel,
      channelAccountId: data.channelAccountId,
      type: data.type,
      body: data.body,
      attachments,
      providerMessageId: data.providerMessageId,
      requestId: data.requestId,
    });
    // El hilo del proveedor se aprende de lo que entra (ADR-0033): así la
    // respuesta sale dentro de la misma conversación, sin pedirle a Zernio que
    // abra otra. En la misma transacción que el mensaje.
    if (data.providerThreadId && data.channelAccountId) {
      await recordarHilo(client, {
        tenantId: data.tenantId,
        cuentaId: data.channelAccountId,
        peer: data.phone,
        hilo: data.providerThreadId,
      });
    }
    // El canal pasa cada texto por el consentimiento (SPEC §8): "BASTA" marca
    // opt-out en la misma transacción que el mensaje.
    let optedOut = false;
    if (data.body) {
      ({ optedOut } = await handleInboundForConsent(client, {
        tenantId: data.tenantId,
        contactId: res.contact.id,
        text: data.body,
        requestId: data.requestId,
      }));
    }
    // Asignación automática según el modo del tenant (#38): solo cuando la
    // conversación quedó en `new` sin dueño (nueva o reabierta a la cola).
    let assignedTo: string | null = null;
    if (!optedOut && res.conversation.state === 'new' && !res.conversation.ownerId) {
      ({ assignedTo } = await autoAssignNew(client, {
        tenantId: data.tenantId,
        conversationId: res.conversation.id,
        requestId: data.requestId,
      }));
    }
    return {
      conversationId: res.conversation.id,
      messageId: res.message.id,
      contactId: res.contact.id,
      contactCreated: res.contactCreated,
      conversationCreated: res.conversationCreated,
      reopened: res.reopened,
      optedOut,
      assignedTo,
      // Los que de verdad quedaron: con `key` si se guardaron, con `url` si
      // no se pudo (#1200). Quien encola la sugerencia necesita ESTOS.
      attachments,
    };
  });
  return outcome;
}
