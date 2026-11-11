import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@iaxti/db';
import { esNombreDeVariable, storageFromEnv } from '@iaxti/core';
import { autoAssignNew, receiveInbound } from '@iaxti/module-conversations';
import type { Channel, MessageType } from '@iaxti/module-conversations';
import { handleInboundForConsent } from '@iaxti/module-crm';
import type { Contact } from '@iaxti/module-crm';
import { findAccountById, recordarHilo } from '@iaxti/module-channels';
import {
  baseDeZernio,
  downloadAttachmentsToR2,
  identidadDePerfil,
  type AdjuntoEntrante,
} from '@iaxti/module-whatsapp';
import type { PerfilJob } from './perfil-de-whatsapp';

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
 * El job que va a buscarle el nombre de perfil a este contacto, o `null`
 * (#1170).
 *
 * Devuelve un JOB, no un nombre: acá no se llama a nadie. La consulta a Zavu
 * corre en su propia cola y el por qué está en `perfil-de-whatsapp.ts`.
 *
 * ## La decisión se toma con el TELÉFONO, no con el canal
 *
 * Antes se decidía con `data.channel === 'whatsapp'` y el nombre vacío, y eso
 * daba por hecho que en WhatsApp la identidad es un número. No lo es:
 * `ensureContactByIdentity` acepta dos formas OPACAS —BSUID (`US.<dígitos>`) y
 * JID de grupo (`<dígitos>@g.us`)— y para esas crea el contacto con
 * `phone = NULL`. `digitos('US.13491208655302741918')` deja 20 dígitos, así
 * que ninguna guarda de «¿parece un teléfono?» las paraba: salía un
 * `GET /contacts?search=1349…` por CADA mensaje de ese contacto, para siempre,
 * y jamás podía calzar porque se compara contra un teléfono.
 *
 * Así que lo que se busca es `contacto.phone` —el E.164 que YA quedó
 * guardado—, no `data.phone`. Y si no hay teléfono, la identidad cruda se
 * clasifica: el BSUID tiene su propio camino en Zavu (se comprueba contra
 * `whatsapp.bsuid`, que la respuesta medida expone), y el JID de grupo no
 * entra, porque un grupo no tiene nombre de perfil.
 *
 * Las otras dos condiciones siguen igual:
 *  · el contacto quedó SIN nombre — si ya tiene uno, no se toca: puede haberlo
 *    escrito alguien del negocio y eso manda sobre el perfil;
 *  · hay cuenta de canal, que es de donde sale la credencial. Por REFERENCIA,
 *    nunca el valor (SPEC §17): lo lee el job, no esta transacción.
 */
async function trabajoDelNombre(
  client: PoolClient,
  data: InboundJob,
  contacto: Contact,
): Promise<PerfilJob | null> {
  const canal = data.channel ?? 'whatsapp';
  if (canal !== 'whatsapp' || contacto.name?.trim() || !data.channelAccountId) return null;
  // El teléfono guardado primero; la identidad cruda solo cuando no hay
  // teléfono, que es el caso del BSUID.
  const identidad = identidadDePerfil(contacto.phone ?? data.phone);
  if (!identidad) return null;
  // Un contacto con teléfono guardado no se busca por su identidad cruda: eso
  // es lo que mandaba `US.134…` a una búsqueda de teléfonos.
  if (!contacto.phone && identidad.tipo !== 'bsuid') return null;
  const account = await findAccountById(client, data.channelAccountId);
  const ref = account?.credentialRef;
  if (!ref || !esNombreDeVariable(ref)) return null;
  return {
    moduleId: 'whatsapp',
    tenantId: data.tenantId,
    contactId: contacto.id,
    identidad,
    credencialRef: ref,
    requestId: data.requestId,
  };
}

/**
 * Encolar el job del nombre de perfil. Lo inyecta `main.ts` con la cola real.
 *
 * Es un puerto y no un `Queue` importado acá para que el camino de entrada se
 * pueda medir sin Redis — y para que la prueba pueda EXIGIR que lo que sale de
 * este job sea un encolado y no una llamada HTTP.
 */
export type EncolarPerfil = (job: PerfilJob) => Promise<void>;

export async function processInbound(
  pool: Pool,
  data: InboundJob,
  encolarPerfil?: EncolarPerfil,
): Promise<InboundOutcome> {
  if (!data.tenantId || !data.phone) {
    throw new Error('inbound: el job necesita tenantId y phone.');
  }
  const { outcome, perfil } = await withTenant(pool, data.tenantId, async (client) => {
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
        const apiKey = account?.credentialRef ? process.env[account.credentialRef] : undefined;
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
            // La llave solo viaja al dominio del proveedor de ESTA cuenta
            // (#1335). Sin esto, una cuenta de Zernio pediría sus adjuntos a
            // zernio.com SIN llave —el dominio por omisión es el de Zavu— y no
            // entraría ninguno. Falla segura, pero falla.
            ...(account.provider === 'zernio' ? { apiBase: baseDeZernio() } : {}),
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
      outcome: {
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
      },
      perfil: await trabajoDelNombre(client, data, res.contact),
    };
  });
  // El nombre de perfil (#1170) se ENCOLA: este job termina en el commit del
  // mensaje y no espera a ningún tercero. Lo que eso evita está contado en
  // `perfil-de-whatsapp.ts`; acá importa el orden —después del commit— y el
  // `catch`: no poder encolar la mejora no puede voltear el mensaje que ya
  // entró.
  if (perfil && encolarPerfil) {
    try {
      await encolarPerfil(perfil);
    } catch (err) {
      // El TIPO del fallo, no su `message`: un error de Redis puede traer la
      // URL de conexión, y acá no se registran datos ni credenciales.
      const causa = (err as { code?: unknown }).code ?? (err as Error).name;
      console.warn(
        `[${data.requestId ?? 'sin-request-id'}] inbound: no se pudo encolar el nombre de perfil (${String(causa)})`,
      );
    }
  }
  return outcome;
}
