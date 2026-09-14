import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ChannelAccountRef,
  ChannelProvider,
  NormalizedInbound,
  OutboundMessage,
} from '@iaxti/module-channels';

// El adaptador Kapso (#42): habla el VOCABULARIO de la Cloud API de Meta
// (Kapso la espeja tal cual), así que el día que seamos Tech Provider solo
// cambia la base URL y la credencial. Kapso sin lógica de negocio: aquí no
// hay flows, ni agentes, ni base gestionada — solo transporte.

const TIPOS_META: Record<string, string> = {
  text: 'texto',
  image: 'imagen',
  audio: 'audio',
  voice: 'audio',
  document: 'documento',
  location: 'ubicacion',
  contacts: 'contacto',
  interactive: 'interactivo',
  button: 'interactivo',
};

interface MetaMessage {
  id: string;
  from: string; // msisdn sin '+'
  timestamp?: string;
  type: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  audio?: { id?: string; mime_type?: string };
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
  location?: { latitude?: number; longitude?: number; name?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  button?: { text?: string };
}

interface MetaStatus {
  id: string; // wamid del saliente
  status?: string; // sent | delivered | read | failed
  errors?: Array<{ code?: number; title?: string; message?: string }>;
  pricing?: Record<string, unknown>;
}

interface MetaWebhook {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: MetaMessage[];
        statuses?: MetaStatus[];
      };
    }>;
  }>;
}

function cuerpoDe(m: MetaMessage): string | undefined {
  if (m.text?.body) return m.text.body;
  if (m.interactive?.button_reply?.title) return m.interactive.button_reply.title;
  if (m.interactive?.list_reply?.title) return m.interactive.list_reply.title;
  if (m.button?.text) return m.button.text;
  if (m.image?.caption) return m.image.caption;
  if (m.document?.caption) return m.document.caption;
  if (m.location) {
    return `Ubicación: ${m.location.name ?? ''} (${m.location.latitude}, ${m.location.longitude})`.trim();
  }
  return undefined;
}

function adjuntosDe(m: MetaMessage): unknown[] | undefined {
  const media = m.image ?? m.audio ?? m.document;
  if (!media?.id) return undefined;
  return [
    {
      mediaId: media.id,
      contentType: media.mime_type,
      name: (m.document?.filename ?? `${m.type}-${media.id}`).slice(-80),
    },
  ];
}

export interface KapsoConfig {
  /** Base del espejo de la Cloud API; el default apunta a Kapso. */
  apiBase?: string;
  /**
   * Cómo viaja la credencial. Kapso autentica su espejo con `X-API-Key`; Meta,
   * el día que seamos Tech Provider (#82), con `Authorization: Bearer`. Es la
   * otra mitad de "migrar es cambiar base URL y auth" de la ADR-0005.
   */
  authScheme?: 'x-api-key' | 'bearer';
  fetchImpl?: typeof fetch;
}

/** El espejo vive bajo /meta/whatsapp/{versión}; sin eso Kapso responde 404. */
export const KAPSO_API_BASE_DEFAULT = 'https://api.kapso.ai/meta/whatsapp/v24.0';

function credencialHeaders(apiKey: string, scheme: 'x-api-key' | 'bearer'): Record<string, string> {
  return scheme === 'bearer' ? { Authorization: `Bearer ${apiKey}` } : { 'X-API-Key': apiKey };
}

function esquemaDe(config: KapsoConfig): 'x-api-key' | 'bearer' {
  const crudo = config.authScheme ?? process.env.KAPSO_AUTH_SCHEME;
  return crudo === 'bearer' ? 'bearer' : 'x-api-key';
}

export function createKapsoProvider(config: KapsoConfig = {}): ChannelProvider {
  const apiBase = config.apiBase ?? process.env.KAPSO_API_BASE ?? KAPSO_API_BASE_DEFAULT;
  const scheme = esquemaDe(config);
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    kind: 'whatsapp',

    async send(account: ChannelAccountRef, message: OutboundMessage) {
      const apiKey = account.credentialRef ? process.env[account.credentialRef] : undefined;
      if (!apiKey) throw new Error('La cuenta de WhatsApp no tiene credencial configurada.');
      const phoneNumberId = account.config.phoneNumberId as string | undefined;
      if (!phoneNumberId) throw new Error('La cuenta de WhatsApp no tiene phone_number_id.');
      // Vocabulario Cloud API tal cual (POST /{phone_number_id}/messages).
      const res = await fetchImpl(`${apiBase}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          ...credencialHeaders(apiKey, scheme),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: message.to.replace(/^\+/, ''),
          type: 'text',
          text: { body: message.body ?? '' },
          ...message.extra,
        }),
      });
      if (!res.ok) {
        // El motivo viene en el cuerpo (plantilla no aprobada, ventana cerrada,
        // número no opt-in). Sin él, depurar un envío caído es adivinar.
        const motivo = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`WhatsApp no aceptó el envío: HTTP ${res.status} ${motivo}`.trim());
      }
      const data = (await res.json()) as { messages?: Array<{ id: string }> };
      const id = data.messages?.[0]?.id;
      if (!id) throw new Error('WhatsApp no devolvió el id del mensaje.');
      return { providerMessageId: id };
    },

    // Mismo esquema que Meta: X-Hub-Signature-256 = 'sha256=' + HMAC del crudo.
    verifyWebhook(headers, rawBody, secret) {
      const header = headers['x-hub-signature-256'] ?? headers['x-iaxti-signature'];
      const cruda = Array.isArray(header) ? header[0] : header;
      if (!cruda || !secret) return false;
      const firma = cruda.startsWith('sha256=') ? cruda : `sha256=${cruda}`;
      const esperada = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
      const a = Buffer.from(firma);
      const b = Buffer.from(esperada);
      return a.length === b.length && timingSafeEqual(a, b);
    },

    normalize(payload: unknown): NormalizedInbound[] {
      const cuerpo = payload as MetaWebhook;
      const out: NormalizedInbound[] = [];
      for (const entry of cuerpo.entry ?? []) {
        for (const change of entry.changes ?? []) {
          for (const m of change.value?.messages ?? []) {
            if (!m.id || !m.from) continue;
            out.push({
              phone: `+${m.from}`,
              type: TIPOS_META[m.type] ?? 'texto',
              body: cuerpoDe(m),
              attachments: adjuntosDe(m),
              providerMessageId: m.id,
              timestamp: m.timestamp,
            });
          }
        }
      }
      return out;
    },
  };
}

/** Media de la Cloud API: GET /{mediaId} da la URL firmada; expira rápido. */
export async function fetchMediaBytes(
  mediaId: string,
  apiKey: string,
  config: KapsoConfig = {},
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const apiBase = config.apiBase ?? process.env.KAPSO_API_BASE ?? KAPSO_API_BASE_DEFAULT;
  const credencial = credencialHeaders(apiKey, esquemaDe(config));
  const fetchImpl = config.fetchImpl ?? fetch;
  const meta = await fetchImpl(`${apiBase}/${mediaId}`, { headers: credencial });
  if (!meta.ok) throw new Error(`No pudimos ubicar el adjunto: HTTP ${meta.status}`);
  const { url, mime_type } = (await meta.json()) as { url?: string; mime_type?: string };
  if (!url) throw new Error('WhatsApp no devolvió la URL del adjunto.');
  const bin = await fetchImpl(url, { headers: credencial });
  if (!bin.ok) throw new Error(`No pudimos bajar el adjunto: HTTP ${bin.status}`);
  return {
    bytes: await bin.arrayBuffer(),
    contentType: mime_type ?? bin.headers.get('content-type') ?? 'application/octet-stream',
  };
}

export interface DeliveryStatusUpdate {
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  errorCode?: number;
  errorDetail?: string;
  cost?: Record<string, unknown>;
}

/** Los estados de entrega del webhook de Meta (value.statuses[], #43). */
export function normalizeStatuses(payload: unknown): DeliveryStatusUpdate[] {
  const cuerpo = payload as MetaWebhook;
  const out: DeliveryStatusUpdate[] = [];
  for (const entry of cuerpo.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const st of change.value?.statuses ?? []) {
        if (!st.id) continue;
        const status = st.status as DeliveryStatusUpdate['status'] | undefined;
        if (!status || !['sent', 'delivered', 'read', 'failed'].includes(status)) continue;
        const error = st.errors?.[0];
        out.push({
          providerMessageId: st.id,
          status,
          errorCode: error?.code,
          errorDetail: error?.message ?? error?.title,
          cost: st.pricing,
        });
      }
    }
  }
  return out;
}
