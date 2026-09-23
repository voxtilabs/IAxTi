import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ChannelAccountRef,
  ChannelKind,
  ChannelProvider,
  NormalizedInbound,
  OutboundMessage,
} from '@iaxti/module-channels';

// El adaptador Zavu (#42, ADR-0014): UN transporte para WhatsApp, Instagram y
// Messenger — mismo envelope, misma firma, mismos estados. Zavu sin lógica de
// negocio: sus Agents, Functions, Flows, Memory y Broadcasts no se usan.
// Su vocabulario no cruza este archivo: hacia adentro solo salen las formas
// del puerto.

import { baseDeZavu } from './zavu-base';
import {
  crearEnZavu,
  enviarARevisionEnZavu,
  envioDePlantilla,
  listarEnZavu,
  type PlantillaEnZavu,
} from './zavu-plantillas';
import type { CategoriaPlantilla } from '../domain/plantillas';

/**
 * De la forma de Zavu a la NUESTRA (#159).
 *
 * Un campo con el nombre del proveedor en el puerto sería la misma
 * dependencia por otra puerta: `whatsappStatus` se llama `estadoDeMeta`
 * porque eso es lo que significa, venga de quien venga.
 */
/**
 * Un adjunto, en la forma que Zavu espera (#458).
 *
 * `messageType` sale del tipo del archivo y no del nombre: un `.jpg`
 * renombrado a `.pdf` se manda como imagen igual, porque lo que el
 * proveedor mira es el contenido.
 *
 * Solo el PRIMERO. WhatsApp manda un medio por mensaje, y pasar el resto en
 * silencio sería prometer que salieron.
 */
function envioDeAdjunto(
  adjuntos?: Array<{ url: string; filename?: string; contentType?: string }>,
): Record<string, unknown> {
  const a = adjuntos?.[0];
  if (!a) return {};
  const tipo = (a.contentType ?? '').toLowerCase();
  const messageType = tipo.startsWith('image/')
    ? 'image'
    : tipo.startsWith('video/')
      ? 'video'
      : tipo.startsWith('audio/')
        ? 'audio'
        : 'document';
  return {
    messageType,
    content: {
      mediaUrl: a.url,
      // El nombre solo tiene sentido en un documento: en una imagen, lo que
      // se ve es el pie de foto.
      ...(messageType === 'document' && a.filename ? { filename: a.filename } : {}),
    },
  };
}

function deZavu(t: PlantillaEnZavu) {
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    status: t.status,
    category: t.category as string,
    ...(t.whatsappStatus ? { estadoDeMeta: t.whatsappStatus } : {}),
    ...(t.rejectionReason ? { motivoDeRechazo: t.rejectionReason } : {}),
  };
}

export { ZAVU_API_BASE_DEFAULT } from './zavu-base';

/** Qué canal de Zavu corresponde a cada `kind` del puerto. */
const CANAL: Partial<Record<ChannelKind, string>> = {
  whatsapp: 'whatsapp',
  instagram: 'instagram',
  messenger: 'messenger',
};

const TIPOS: Record<string, string> = {
  text: 'texto',
  image: 'imagen',
  video: 'video',
  audio: 'audio',
  voice: 'audio',
  sticker: 'imagen',
  document: 'documento',
  location: 'ubicacion',
  contact: 'contacto',
  buttons: 'interactivo',
  list: 'interactivo',
  interactive: 'interactivo',
  reaction: 'reaccion',
};

/** El envelope de Zavu: `{id,type,timestamp,senderId,projectId,data}`. */
interface ZavuEvent {
  id?: string;
  type?: string;
  timestamp?: number;
  senderId?: string;
  data?: {
    messageId?: string;
    conversationId?: string | null;
    from?: string;
    to?: string;
    channel?: string;
    messageType?: string;
    text?: string;
    status?: string;
    providerTimestamp?: number | null;
    errorCode?: number | string;
    errorMessage?: string;
    cost?: Record<string, unknown>;
    content?: Record<string, unknown>;
    referral?: Record<string, unknown>;
  };
}

export interface DeliveryStatusUpdate {
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  /** Código del proveedor: numérico si viene de Meta, de texto si es de Zavu. */
  errorCode?: number | string;
  errorDetail?: string;
  /** Lo que cobró el canal, cuando lo informa. */
  cost?: Record<string, unknown>;
}

export interface ZavuConfig {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Solo para tests: el reloj con el que se juzga la frescura de la firma. */
  now?: () => number;
}

function adjuntosDe(data: NonNullable<ZavuEvent['data']>): unknown[] | undefined {
  const contenido = data.content ?? {};
  const url = (contenido.mediaUrl ?? (data as Record<string, unknown>).mediaUrl) as string | undefined;
  if (!url) return undefined;
  return [
    {
      url,
      contentType: contenido.mimeType as string | undefined,
      name: ((contenido.filename as string | undefined) ?? `${data.messageType ?? 'archivo'}`).slice(-80),
    },
  ];
}

/**
 * La firma de Zavu: `X-Zavu-Signature: t=<seg>[,v1=<hex>][,v2=<hex>]`.
 * `v1` cubre el cuerpo; `v2` cubre `{t}.{body}` y es el esquema vigente. Se
 * prefiere v2 y se acepta v1, para que la misma implementación sirva antes,
 * durante y después de la migración de un sender viejo.
 */
export function verifyZavuSignature(
  header: string | undefined,
  rawBody: string,
  secret: string,
  now: () => number = Date.now,
): boolean {
  if (!header || !secret) return false;
  const partes: Record<string, string> = {};
  for (const trozo of header.split(',')) {
    const i = trozo.indexOf('=');
    if (i > 0) partes[trozo.slice(0, i).trim()] = trozo.slice(i + 1).trim();
  }
  const t = Number(partes.t);
  if (!Number.isFinite(t)) return false;
  // Ventana de frescura: una firma vieja es una repetición.
  const edad = Math.floor(now() / 1000) - t;
  if (edad > 300 || edad < -60) return false;

  const recibida = partes.v2 ?? partes.v1;
  if (!recibida) return false;
  const firmado = partes.v2 ? `${t}.${rawBody}` : rawBody;
  const esperada = createHmac('sha256', secret).update(firmado).digest('hex');
  if (esperada.length !== recibida.length) return false;
  return timingSafeEqual(Buffer.from(esperada), Buffer.from(recibida));
}

export function createZavuProvider(
  kind: ChannelKind = 'whatsapp',
  config: ZavuConfig = {},
): ChannelProvider {
  const canal = CANAL[kind];
  if (!canal) throw new Error(`Zavu no transporta el canal "${kind}".`);
  const apiBase = baseDeZavu(config.apiBase);
  /**
   * El `fetch` se resuelve al LLAMAR, no al crear el adaptador.
   *
   * Capturado al crear, el adaptador se queda con la referencia que había
   * en ese instante: quien lo registre al arrancar el proceso —que es lo
   * correcto— deja fuera cualquier reemplazo posterior. Se vio al registrar
   * los adaptadores en los workers (#159): el barrido de plantillas seguía
   * llamando al `fetch` real aunque el test lo hubiera cambiado.
   */
  const fetchImpl: typeof fetch = (...args) => (config.fetchImpl ?? globalThis.fetch)(...args);
  const now = config.now ?? Date.now;

  /**
   * De dónde saca cada cuenta su credencial y su emisor.
   *
   * La credencial va POR REFERENCIA: la cuenta guarda el NOMBRE de la
   * variable, nunca el valor.
   */
  const configDeLaCuenta = (account: ChannelAccountRef) => {
    const apiKey = account.credentialRef ? process.env[account.credentialRef] : undefined;
    if (!apiKey) throw new Error('La cuenta de canal no tiene credencial configurada.');
    const senderId = account.config.senderId as string | undefined;
    if (!senderId) throw new Error('La cuenta de canal no tiene senderId.');
    return { cfg: { apiKey, apiBase, fetchImpl }, senderId };
  };

  return {
    kind,

    /**
     * Las plantillas, por el puerto y no por su nombre (#159).
     *
     * La API y el worker llamaban a `crearEnZavu` y compañía directamente,
     * así que salir del intermediario era una línea en la mitad del
     * producto y una reescritura en la otra. Solo WhatsApp las tiene:
     * Instagram y Messenger comparten transporte pero no plantillas.
     */
    ...(kind === 'whatsapp'
      ? {
          plantillas: {
            async crear(account: ChannelAccountRef, input) {
              const { cfg } = configDeLaCuenta(account);
              return deZavu(
                await crearEnZavu(cfg, {
                  name: input.name,
                  language: input.language,
                  body: input.body,
                  category: input.category as CategoriaPlantilla,
                  footer: input.footer,
                  buttons: input.buttons,
                }),
              );
            },
            async enviarARevision(account: ChannelAccountRef, input) {
              const { cfg, senderId } = configDeLaCuenta(account);
              return deZavu(
                await enviarARevisionEnZavu(cfg, {
                  templateId: input.templateId,
                  senderId,
                  category: input.category as CategoriaPlantilla,
                }),
              );
            },
            async listar(account: ChannelAccountRef) {
              const { cfg, senderId } = configDeLaCuenta(account);
              return (await listarEnZavu(cfg, senderId)).map(deZavu);
            },
          },
        }
      : {}),

    async send(account: ChannelAccountRef, message: OutboundMessage) {
      const apiKey = account.credentialRef ? process.env[account.credentialRef] : undefined;
      if (!apiKey) throw new Error('La cuenta de canal no tiene credencial configurada.');
      const senderId = account.config.senderId as string | undefined;
      if (!senderId) throw new Error('La cuenta de canal no tiene senderId.');

      const res = await fetchImpl(`${apiBase}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Zavu-Sender': senderId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // `to` va tal cual: E.164, correo, BSUID de WhatsApp o id de chat.
          // Un BSUID es opaco y se devuelve como llegó; normalizarlo lo rompe.
          to: message.to,
          channel: canal,
          ...(message.body !== undefined ? { text: message.body } : {}),
          // El adjunto tampoco viaja como texto (#458): Zavu lo quiere como
          // `messageType` + `content.mediaUrl`, y el cuerpo pasa a ser el
          // pie de foto. Uno por mensaje, que es lo que WhatsApp permite:
          // mandar el segundo como si nada sería perderlo en silencio.
          ...envioDeAdjunto(message.attachments),
          // Una plantilla no viaja como texto: Zavu la quiere como
          // `messageType: 'template'` con el id del proveedor y las
          // variables por posición. La traducción vive acá y no en el
          // dominio, que no tiene por qué saber de `messageType`.
          ...(message.extra?.plantilla
            ? envioDePlantilla(message.extra.plantilla as Record<string, never>)
            : {}),
          ...(message.extra && !message.extra.plantilla ? message.extra : {}),
        }),
      });
      if (!res.ok) {
        // El motivo viene en el cuerpo: ventana cerrada, plantilla sin aprobar,
        // destinatario no verificado, tope diario. Sin él, depurar es adivinar.
        const motivo = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`El canal no aceptó el envío: HTTP ${res.status} ${motivo}`.trim());
      }
      const data = (await res.json()) as {
        id?: string;
        messageId?: string;
        message?: { id?: string };
      };
      // Los prefijos de id de Zavu no son contrato (la doc muestra `msg_...`
      // y el webhook devuelve ids pelados), así que se leen las tres formas.
      const id = data.message?.id ?? data.id ?? data.messageId;
      if (!id) throw new Error('El canal no devolvió el id del mensaje.');
      return { providerMessageId: id };
    },

    verifyWebhook(headers, rawBody, secret) {
      const cruda = headers['x-zavu-signature'];
      return verifyZavuSignature(Array.isArray(cruda) ? cruda[0] : cruda, rawBody, secret, now);
    },

    normalize(payload: unknown): NormalizedInbound[] {
      const evento = payload as ZavuEvent;
      // Un envelope, un evento. Solo los entrantes se convierten en mensaje:
      // `direction` no sirve para filtrar acá porque `status` no distingue
      // dirección — el tipo de evento sí.
      if (evento.type !== 'message.inbound') return [];
      const data = evento.data;
      if (!data?.messageId || !data.from) return [];
      return [
        {
          phone: data.from,
          type: TIPOS[data.messageType ?? 'text'] ?? 'texto',
          body: data.text,
          attachments: adjuntosDe(data),
          providerMessageId: data.messageId,
          timestamp: String(
            Math.floor((data.providerTimestamp ?? evento.timestamp ?? now()) / 1000),
          ),
        },
      ];
    },
  };
}

/**
 * Estados de entrega. La verdad la dice el TIPO del evento, no el campo
 * `status` del cuerpo: en Zavu un entrante también queda `delivered`.
 */
const ESTADO_POR_EVENTO: Record<string, DeliveryStatusUpdate['status']> = {
  'message.sent': 'sent',
  'message.delivered': 'delivered',
  'message.read': 'read',
  'message.failed': 'failed',
};

export function normalizeStatuses(payload: unknown): DeliveryStatusUpdate[] {
  const evento = payload as ZavuEvent;
  const estado = ESTADO_POR_EVENTO[evento.type ?? ''];
  const id = evento.data?.messageId;
  if (!estado || !id) return [];
  const data = evento.data ?? {};
  return [
    {
      providerMessageId: id,
      status: estado,
      ...(data.errorCode !== undefined ? { errorCode: data.errorCode } : {}),
      ...(data.errorMessage ? { errorDetail: data.errorMessage } : {}),
      ...(data.cost ? { cost: data.cost } : {}),
    },
  ];
}

/** La atribución click-to-WhatsApp llega SOLO en el primer mensaje del hilo. */
export function referralDe(payload: unknown): Record<string, unknown> | null {
  const evento = payload as ZavuEvent;
  return evento.type === 'message.inbound' ? (evento.data?.referral ?? null) : null;
}

/** Los adjuntos de Zavu vienen por URL firmada y de vida corta: se bajan al llegar. */
export async function fetchMediaBytes(
  url: string,
  apiKey: string,
  config: ZavuConfig = {},
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const bin = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!bin.ok) throw new Error(`No pudimos bajar el adjunto: HTTP ${bin.status}`);
  return {
    bytes: await bin.arrayBuffer(),
    contentType: bin.headers.get('content-type') ?? 'application/octet-stream',
  };
}
