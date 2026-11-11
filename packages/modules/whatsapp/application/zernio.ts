import { claseDeAdjunto } from '@iaxti/module-channels';
import type {
  ChannelAccountRef,
  ChannelProvider,
  ClaseDeAdjunto,
  NormalizedInbound,
  OutboundMessage,
} from '@iaxti/module-channels';

// El adaptador Zernio (#1317, ADR-0032): el segundo proveedor de canales, el
// que manda por CONVERSACIÓN y no por destinatario (ADR-0033). Mismo estilo
// que Zavu — el vocabulario de Zernio no cruza este archivo: hacia adentro
// solo salen las formas del puerto.
//
// Lo que acá es distinto a Zavu, y por qué, está en los comentarios de cada
// pieza; el núcleo de seguridad (firma del webhook y llave por llamada) vive
// en `zernio-base` y no se duplica acá.

import { ErrorPermanente } from './outbound';
import {
  baseDeZernio,
  ErrorDeZernio,
  llamarAZernio,
  llaveDeLaCuenta,
  verifyZernioSignature,
  type ConfigDeZernio,
} from './zernio-base';

/** Qué `kind` del puerto sabe atender Zernio: su bandeja es la misma para los tres. */
const KINDS_DE_ZERNIO = ['whatsapp', 'instagram', 'messenger'] as const;

export interface ZernioConfig {
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

/**
 * De la clase de adjunto que declara el canal al `attachmentType` de Zernio.
 *
 * La tabla de clases vive en `channels` y es la que ya decide qué archivo se
 * puede subir; acá solo se traduce, por lo mismo que en `zavu.ts`: no puede
 * haber dos opiniones sobre qué es un webp. Lo que la tabla no reconoce cae
 * a `file`, que es el único envío que Zernio no le exige un formato al
 * archivo (y su defecto, además).
 */
const ATTACHMENT_TYPE_POR_CLASE: Record<ClaseDeAdjunto, string> = {
  imagen: 'image',
  video: 'video',
  audio: 'audio',
  documento: 'file',
  sticker: 'sticker',
};

/**
 * Del tipo de adjunto de Zernio al NUESTRO. Sus nombres no son los de Zavu
 * (`file` y no `document`), así que la traducción es propia del adaptador: el
 * puerto no tiene que saber que existen proveedores que dicen distinto.
 */
const TIPO_POR_ADJUNTO_DE_ZERNIO: Record<string, string> = {
  image: 'imagen',
  video: 'video',
  audio: 'audio',
  // Zernio no distingue el sticker como clase de mensaje: llega como adjunto.
  // En la bandeja se ve como la imagen que es (mismo criterio que Zavu).
  sticker: 'imagen',
  file: 'documento',
  // Un post o reel compartido: no lo podemos mostrar, pero sí notar que llegó.
  share: 'documento',
};

/** El envelope de `message.received` (spec v1.527, `WebhookPayloadMessage`). */
interface EventoDeZernio {
  event?: string;
  message?: {
    id?: string;
    conversationId?: string;
    platformMessageId?: string;
    direction?: string;
    text?: string | null;
    attachments?: Array<{ type?: string; url?: string; mimeType?: string }>;
    sender?: { phoneNumber?: string | null };
    sentAt?: string;
  };
}

/**
 * Un envío dentro de un hilo. El spec dice `data.data` para ZernFlow, pero la
 * respuesta 200 real de ESTA ruta es `{success, data: {messageId, …}}`: cada
 * llamada valida su propia forma, nada de un `res.data.data` genérico.
 */
interface RespuestaDeEnvio {
  data?: { messageId?: string; conversationId?: string };
}

/** La respuesta 201 de crear conversación: el hilo nuevo y el primer mensaje. */
interface RespuestaDeConversacion {
  data?: { messageId?: string; conversationId?: string };
}

/** La plantilla tal como la trae el outbound (`extra.plantilla`, #44). */
interface PlantillaEnElMensaje {
  name?: string;
  language?: string;
  valores?: string[];
}

/** Lo que NO se arregla reintentando; lo demás lo reintenta BullMQ. */
function sinSaberSiSalio(detalle: string): ErrorPermanente {
  return new ErrorPermanente(
    'No sabemos si este mensaje alcanzó a salir. Revisa la conversación antes de volver a enviarlo.',
    detalle,
  );
}

function clasificar(error: unknown, operacion: 'mensajes' | 'conversacion'): unknown {
  if (error instanceof ErrorPermanente) return error;
  if (!(error instanceof ErrorDeZernio)) {
    // Error de red o de parseo: la petición pudo haber llegado. Al crear una
    // conversación eso es ambiguo por la misma razón que el 5xx (sin llave);
    // al mandar dentro de una, el reintento es seguro.
    if (operacion === 'conversacion') {
      return sinSaberSiSalio(`Zernio sin respuesta utilizable: ${String((error as Error)?.message ?? error)}`);
    }
    return error;
  }
  const cuerpo = error.cuerpo.slice(0, 300);
  const detalle = `Zernio HTTP ${error.status} ${cuerpo}`.trim();

  /**
   * El 409 de llave «en proceso» (spec v1.527, `IdempotencyKeyHeader`; la
   * misma trampa que ya pagamos con Zavu): una petición cortada a medias deja
   * la `Idempotency-Key` ocupada hasta 24 horas y Zernio responde 409 mientras
   * tanto. Con la MISMA llave se choca 24 h; con OTRA se arriesga un
   * duplicado, que es justo lo que la llave existía para evitar. No sabemos si
   * el mensaje alcanzó a salir, así que no se reintenta nunca: se le dice a la
   * persona que revise la conversación antes de reenviar.
   */
  if (error.status === 409) return sinSaberSiSalio(detalle);
  if (error.status === 404) {
    // 404 en el envío es el hilo que Zernio ya no tiene: se reporta con el
    // marcador `hilo_vencido` porque #1334 borra la fila y reintenta UNA vez
    // con búsqueda/reconciliación. En la creación es la cuenta o el
    // destinatario que no existen, que tampoco se arregla reintentando.
    return new ErrorPermanente(
      'La conversación de este contacto ya no existe en el proveedor. ' +
        'Se recupera con el próximo mensaje; si vuelve a pasar, reconecta el canal.',
      `${operacion === 'mensajes' ? 'hilo_vencido: ' : ''}${detalle}`,
    );
  }
  if (error.status === 401 || error.status === 403) {
    // 401 es «no sé quién eres», 403 es «sé quién eres y esto no lo puedes
    // hacer»: los dos arreglan reconectando el canal, no reintentando (#596).
    return new ErrorPermanente(
      'El canal rechazó nuestras credenciales. Un administrador tiene que reconectarlo en Canales.',
      detalle,
    );
  }
  if (error.status === 400 || error.status === 422) {
    // La carga o la plantilla están malas (`TEMPLATE_REQUIRED`,
    // `INVALID_TEMPLATE_PARAMS`, …): el `code` va en el detalle porque es lo
    // accionable, no lo que lee una persona.
    return new ErrorPermanente(
      'El proveedor rechazó este envío y reintentarlo no lo va a cambiar. Revisa el mensaje o la plantilla antes de volver a mandarlo.',
      `Zernio HTTP ${error.status}${error.code ? ` code=${error.code}` : ''} ${cuerpo}`.trim(),
    );
  }
  // 429 se relanza TAL CUAL en las dos operaciones: es un rechazo ANTES de
  // procesar, así que reintentar no puede duplicar nada.
  if (error.status === 429) return error;
  if (error.status >= 500) {
    // En `mensajes` el 5xx se reintenta: la ruta lleva `Idempotency-Key` y
    // Zernio deduplica. En `conversacion` NO: esa ruta no acepta llave, y un
    // 5xx no dice si la conversación —con su plantilla— alcanzó a crearse. Un
    // reintento le mandaría la plantilla DOS veces al cliente.
    if (operacion === 'conversacion') return sinSaberSiSalio(detalle);
    return error;
  }
  // El resto de los 4xx (402: se acabó el crédito; …) tampoco se arregla
  // reintentando el mismo mensaje.
  return new ErrorPermanente('El proveedor no aceptó este envío. Revisa el canal antes de reintentar.', detalle);
}

export function createZernioProvider(
  kind: (typeof KINDS_DE_ZERNIO)[number],
  config: ZernioConfig = {},
): ChannelProvider {
  // El tipo ya lo acota; el guard es para quien llame desde JS sin types.
  if (!KINDS_DE_ZERNIO.includes(kind as (typeof KINDS_DE_ZERNIO)[number])) {
    throw new Error(`Zernio no transporta el canal "${String(kind)}".`);
  }
  const apiBase = baseDeZernio(config.apiBase);
  // El `fetch` se resuelve al LLAMAR, no al crear el adaptador, por lo mismo
  // que en `zavu.ts`: capturado al crear, deja fuera cualquier reemplazo
  // posterior y las pruebas dejan de ver la salida real.
  const fetchImpl: typeof fetch = (...args) => (config.fetchImpl ?? globalThis.fetch)(...args);

  return {
    kind,
    proveedor: 'zernio',

    /**
     * Plantillas: NO, todavía. Zernio las tiene (`/v1/whatsapp/templates` y la
     * biblioteca), pero `PuertoDePlantillas` para Zernio va en su propio
     * issue: crearlas y sincronizarlas trae su propia traducción de
     * categorías y estados, y mezclarlo acá haría del adaptador dos PR en
     * uno. Mientras no exista, una cuenta en Zernio no ofrece plantillas — y
     * un envío libre sin hilo lo dice abajo, con error legible.
     */

    async send(account: ChannelAccountRef, message: OutboundMessage) {
      const apiKey = llaveDeLaCuenta(account.credentialRef, account.id);
      const cfg: ConfigDeZernio = { apiKey, apiBase, fetchImpl };
      // El `accountId` de Zernio, no el nuestro: es la cuenta conectada allá
      // que responde por este número. Mismo papel que `senderId` en Zavu.
      const zernioAccountId = account.config.zernioAccountId as string | undefined;
      if (!zernioAccountId) {
        throw new ErrorPermanente(
          'Este canal no tiene su cuenta de Zernio asignada. Reconéctalo en Canales para elegir la cuenta que envía.',
          `La cuenta ${account.id} no trae config.zernioAccountId.`,
        );
      }

      if (message.providerThreadId) {
        // Con hilo: se manda dentro de la conversación, y la llave de
        // idempotencia es OBLIGATORIA — sin ella no se manda nada. Es la única
        // protección contra el duplicado del reintento (#585), y un saliente
        // sin `messageId` es un bug nuestro: mejor no mandar que duplicar.
        if (!message.messageId) {
          throw new ErrorPermanente(
            'El mensaje no trae su llave de idempotencia, así que no se envió: sin ella, un reintento podría duplicarlo. Avísanos para revisarlo.',
            `Envío al hilo ${message.providerThreadId} sin messageId (ADR-0020).`,
          );
        }
        const adjunto = message.attachments?.[0];
        const clase = adjunto ? claseDeAdjunto(adjunto.contentType ?? '', kind) : null;
        try {
          const res = await llamarAZernio<RespuestaDeEnvio>(
            cfg,
            `/v1/inbox/conversations/${encodeURIComponent(message.providerThreadId)}/messages`,
            {
              method: 'POST',
              idempotencyKey: message.messageId,
              body: {
                accountId: zernioAccountId,
                ...(message.body !== undefined ? { message: message.body } : {}),
                // Uno por mensaje, como en Zavu: WhatsApp manda un medio por
                // mensaje y mandar el segundo como si nada sería perderlo.
                ...(adjunto
                  ? {
                      attachmentUrl: adjunto.url,
                      attachmentType: clase ? ATTACHMENT_TYPE_POR_CLASE[clase.clase] : 'file',
                      // El nombre solo sirve a un documento: en una imagen, lo
                      // que se ve es el pie de foto.
                      ...(clase?.clase === 'documento' && adjunto.filename
                        ? { attachmentName: adjunto.filename }
                        : {}),
                    }
                  : {}),
              },
            },
          );
          const id = res.data?.messageId;
          if (!id) {
            // Transitorio a propósito: esta ruta SÍ acepta `Idempotency-Key`,
            // así que el reintento de BullMQ es seguro (Zernio deduplica).
            throw new Error('Zernio no devolvió el id del mensaje.');
          }
          return { providerMessageId: id };
        } catch (e) {
          throw clasificar(e, 'mensajes');
        }
      }

      // Sin hilo conocido. La búsqueda/reconciliación es de #1334: acá solo
      // se crea, y Zernio exige plantilla para abrir una conversación de
      // WhatsApp — que es justo lo que nuestra ventana de 24 h ya obliga.
      const plantilla = message.extra?.plantilla as PlantillaEnElMensaje | undefined;
      if (!plantilla?.name) {
        throw new ErrorPermanente(
          'No hay conversación abierta con este contacto; un mensaje fuera de una conversación tiene que ir con plantilla.',
          `Envío a ${message.to} sin hilo y sin plantilla (ADR-0033); no se hizo ninguna petición.`,
        );
      }
      try {
        const res = await llamarAZernio<RespuestaDeConversacion>(cfg, '/v1/inbox/conversations', {
          method: 'POST',
          // Esta ruta NO acepta `Idempotency-Key` (spec v1.527): el candado
          // por destinatario que la ADR-0033 pone en el worker es lo que
          // evita crear dos conversaciones, no la llave.
          body: {
            accountId: zernioAccountId,
            // Zernio quiere «digits, country code included» — su propio id de
            // remitente va sin el `+` (spec, `sender.id`), así que se quita el
            // de nuestra E.164 y no se normaliza nada más.
            participantId: message.to.replace(/^\+/, ''),
            templateName: plantilla.name,
            ...(plantilla.language ? { templateLanguage: plantilla.language } : {}),
            ...(plantilla.valores?.length ? { templateParams: plantilla.valores } : {}),
          },
        });
        const hilo = res.data?.conversationId;
        const id = res.data?.messageId;
        if (!hilo || !id) {
          // Permanente a propósito: si la llamada llegó a crear la
          // conversación y la respuesta se perdió, un reintento fabricaría
          // OTRA (la ruta no acepta llave). Mejor que alguien revise.
          throw new ErrorPermanente(
            'No sabemos si este mensaje alcanzó a salir. Revisa la conversación antes de volver a enviarlo.',
            `Zernio respondió 201 sin conversationId ni messageId: ${JSON.stringify(res).slice(0, 200)}`,
          );
        }
        return { providerMessageId: id, providerThreadId: hilo };
      } catch (e) {
        throw clasificar(e, 'conversacion');
      }
    },

    verifyWebhook(headers, rawBody, secret) {
      return verifyZernioSignature(headers, rawBody, secret);
    },

    normalize(payload: unknown): NormalizedInbound[] {
      const evento = payload as EventoDeZernio;
      // Solo `message.received` ES un mensaje del cliente: los demás eventos
      // de la bandeja (sent, delivery status, edited…) tienen su propio
      // tratamiento o todavía no lo tienen, y tratarlos como entrantes es
      // fabricar mensajes.
      if (evento.event !== 'message.received') return [];
      const m = evento.message;
      if (!m) return [];
      // Zernio también avisa de lo que sale por su API. El spec llama a la
      // dirección `outgoing` (y el diseño del issue decía `outbound` por
      // copiar a ZernFlow): se acepta SOLO lo que declara venir del cliente,
      // y cualquier otra dirección se ignora — si no, cada respuesta nuestra
      // reentraba como mensaje del cliente y el agente le contesta a su
      // propia salida (el loop de ZernFlow).
      if (m.direction !== 'incoming') return [];
      const phone = m.sender?.phoneNumber;
      if (!phone) {
        // #1331: Meta está migrando a BSUID y un mensaje puede llegar sin
        // teléfono. No se inventa (ni con `sender.id`, que a veces es el
        // BSUID): un contacto falso es peor que un mensaje que no entra. El
        // aviso visible de estos mensajes es de ese issue, no del adaptador.
        return [];
      }
      const providerMessageId = m.platformMessageId ?? m.id;
      if (!providerMessageId || !m.conversationId) return [];
      const adjunto = m.attachments?.find((a) => a.url);
      return [
        {
          phone,
          type: adjunto ? (TIPO_POR_ADJUNTO_DE_ZERNIO[adjunto.type ?? ''] ?? 'documento') : 'texto',
          body: m.text ?? undefined,
          attachments: adjunto
            ? [{ url: adjunto.url, contentType: adjunto.mimeType, name: adjunto.type }]
            : undefined,
          providerMessageId,
          // El hilo por donde llegó: el camino de entrada lo recuerda (ADR-0033).
          providerThreadId: m.conversationId,
          timestamp: m.sentAt,
        },
      ];
    },
  };
}

// Reexportado para el contrato: misma costumbre que Zavu con su base.
export { ZERNIO_API_BASE_DEFAULT } from './zernio-base';
