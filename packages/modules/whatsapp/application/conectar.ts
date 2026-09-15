import type { PoolClient } from 'pg';
import { connectWhatsAppNumber, type WhatsAppNumber } from './numbers';
import { ZAVU_API_BASE_DEFAULT } from './zavu';
import type { ChannelAccountRef, ChannelKind } from '@iaxti/module-channels';

// Conectar un canal de Zavu a un tenant (#42, #56). Existe para que el día
// que llegue la credencial esto sea UN comando y no una lista de pasos que
// alguien va a hacer a medias a las once de la noche.
//
// Todo lo decidible se decide acá y se puede probar sin red: qué sender
// sirve, qué webhook registrar, qué falta. La parte que habla con Zavu entra
// inyectada.

export interface SenderZavu {
  id: string;
  name: string;
  channels: string[];
  isDefault?: boolean;
  webhook?: { url?: string | null; signatureVersion?: string | null; active?: boolean };
}

export type LlamarZavu = (
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<unknown>;

/** Cliente mínimo contra la API de Zavu; se inyecta en los tests. */
export function clienteZavu(apiKey: string, apiBase = process.env.ZAVU_API_BASE ?? ZAVU_API_BASE_DEFAULT): LlamarZavu {
  return async (path, init = {}) => {
    const res = await fetch(`${apiBase}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) {
      const motivo = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`Zavu respondió HTTP ${res.status} en ${path}. ${motivo}`.trim());
    }
    return res.json();
  };
}

/**
 * De todos los senders del proyecto, cuál sirve para este canal. Con varios,
 * no se adivina: se listan y se pide elegir. Conectar el número equivocado
 * al tenant equivocado es de las cosas más caras de deshacer.
 */
export function elegirSender(
  senders: SenderZavu[],
  kind: ChannelKind,
  senderIdPedido?: string,
): { sender: SenderZavu } | { error: string; candidatos: SenderZavu[] } {
  const sirven = senders.filter((s) => s.channels?.includes(kind));
  if (senderIdPedido) {
    const exacto = sirven.find((s) => s.id === senderIdPedido);
    if (exacto) return { sender: exacto };
    return {
      error: `El sender ${senderIdPedido} no existe o no tiene el canal ${kind} encendido.`,
      candidatos: sirven,
    };
  }
  if (sirven.length === 0) {
    return {
      error: `Ningún sender del proyecto tiene ${kind}. Conecta la cuenta en Zavu primero (partner invitation) y vuelve a correr esto.`,
      candidatos: senders,
    };
  }
  if (sirven.length > 1) {
    return {
      error: `Hay ${sirven.length} senders con ${kind}: elige uno con --sender. No adivino cuál es el del negocio.`,
      candidatos: sirven,
    };
  }
  return { sender: sirven[0] };
}

/** La URL del webhook de un tenant: la misma forma que ya recibe #41. */
export function urlWebhook(baseUrl: string, accountId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/webhooks/channels/${accountId}`;
}

/** Los eventos que el producto necesita. Pedir de más es ruido que igual se descarta. */
export const EVENTOS_WEBHOOK = [
  'message.inbound',
  'conversation.new',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'template.status_changed',
] as const;

export interface ResultadoConexion {
  number: WhatsAppNumber;
  account: ChannelAccountRef;
  senderId: string;
  webhookUrl: string;
  /** El secreto solo se ve UNA vez: va al env, nunca a la base. */
  webhookSecret: string | null;
  avisos: string[];
}

/**
 * Conecta el sender al tenant: crea la cuenta de canal y el número, y deja
 * el webhook apuntando a nuestra API. La credencial se guarda POR REFERENCIA
 * (el NOMBRE de la variable), jamás el valor.
 */
export async function conectarSender(
  client: PoolClient,
  input: {
    tenantId: string;
    nombre: string;
    sender: SenderZavu;
    baseUrl: string;
    credentialRef: string;
    webhookSecretRef: string;
    llamar: LlamarZavu;
    kind?: ChannelKind;
  },
): Promise<ResultadoConexion> {
  const avisos: string[] = [];
  const { number, account } = await connectWhatsAppNumber(client, {
    tenantId: input.tenantId,
    name: input.nombre,
    senderId: input.sender.id,
    displayPhone: input.sender.name,
    credentialRef: input.credentialRef,
    webhookSecretRef: input.webhookSecretRef,
  });

  const webhookUrl = urlWebhook(input.baseUrl, account.id);
  await input.llamar(`/senders/${input.sender.id}`, {
    method: 'PATCH',
    body: {
      webhookUrl,
      webhookEvents: [...EVENTOS_WEBHOOK],
      webhookActive: true,
    },
  });

  // El secreto se rota para tenerlo: Zavu solo lo muestra al crearlo.
  let webhookSecret: string | null = null;
  try {
    const rotado = (await input.llamar(`/senders/${input.sender.id}/webhook-secret/regenerate`, {
      method: 'POST',
    })) as { secret?: string };
    webhookSecret = rotado?.secret ?? null;
  } catch (err) {
    avisos.push(
      `No pude rotar el secreto del webhook (${(err as Error).message}). Sácalo del panel y guárdalo como ${input.webhookSecretRef}.`,
    );
  }
  if (!webhookSecret) {
    avisos.push(
      `Sin el secreto en ${input.webhookSecretRef}, TODO webhook entrante se rechaza por firma inválida. Es el paso que no se puede saltar.`,
    );
  }
  if (input.sender.webhook?.signatureVersion === 'v1') {
    avisos.push(
      'Este sender firma con el esquema v1 (antiguo). El adaptador lo acepta, pero conviene moverlo a v2 en Zavu.',
    );
  }

  return { number, account, senderId: input.sender.id, webhookUrl, webhookSecret, avisos };
}
