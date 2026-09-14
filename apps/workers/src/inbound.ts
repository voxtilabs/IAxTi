import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { storageFromEnv } from '@iaxti/core';
import { autoAssignNew, receiveInbound } from '@iaxti/module-conversations';
import type { Channel, MessageType } from '@iaxti/module-conversations';
import { handleInboundForConsent } from '@iaxti/module-crm';
import { findAccountById } from '@iaxti/module-channels';
import { downloadAttachmentsToR2, type AdjuntoEntrante } from '@iaxti/module-whatsapp';

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
}

export async function processInbound(pool: Pool, data: InboundJob): Promise<InboundOutcome> {
  if (!data.tenantId || !data.phone) {
    throw new Error('inbound: el job necesita tenantId y phone.');
  }
  return withTenant(pool, data.tenantId, async (client) => {
    // Adjuntos (#42): las URLs del proveedor son firmadas y de vida corta — se
    // bajan AL LLEGAR y van a R2 por tenant; en el mensaje queda solo la llave
    // (carpeta whatsapp/ del tenant). Si la descarga falla, el mensaje entra
    // igual con la metadata original: perder el texto por un adjunto sería peor.
    let attachments = data.attachments;
    const conMedia = (attachments as AdjuntoEntrante[] | undefined)?.some((a) => a?.url);
    if (conMedia && data.channelAccountId) {
      try {
        const account = await findAccountById(client, data.channelAccountId);
        const apiKey = account?.credentialRef ? process.env[account.credentialRef] : undefined;
        const storage = storageFromEnv();
        if (account && apiKey && storage) {
          attachments = await downloadAttachmentsToR2({
            tenantId: data.tenantId,
            conversationId: 'whatsapp',
            attachments: attachments as AdjuntoEntrante[],
            apiKey,
            storage,
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
    };
  });
}
