import { baseDeZavu } from './zavu-base';
import { TIPOS } from './zavu';

/**
 * Preguntarle al canal qué mensaje es ese (#1265).
 *
 * Zavu avisa de lo que el dueño manda desde su teléfono, pero lo hace como el
 * ESTADO de un mensaje que nosotros no conocemos: el evento trae el id y nada
 * más. Para importarlo hay que ir a buscarlo.
 *
 * Modelado como `nombreDePerfil`: `fetch` inyectable para poder medirlo por el
 * puerto (#870), plazo propio, los motivos CLASIFICADOS y no copiados —el
 * mensaje de un `fetch` fallido suele traer la URL, y la URL puede llevar el
 * teléfono—, y **nunca lanza**. Un eco que no se pudo consultar es un mensaje
 * que falta en la bandeja; no puede ser un job que revienta y reintenta cinco
 * veces contra el proveedor.
 */
const TIMEOUT_POR_DEFECTO = 8_000;

export interface ConsultaDelCanal {
  apiKey: string;
  apiBase?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  avisar?: (motivo: string) => void;
}

export interface MensajeDelCanal {
  /** El id de ZAVU, que es el espacio donde vive nuestro `provider_message_id`. */
  providerMessageId: string;
  direction: 'inbound' | 'outbound';
  from: string | null;
  to: string | null;
  channel: string | null;
  type: string;
  text: string | null;
  status: 'sent' | 'delivered' | 'read' | 'failed' | null;
  /** El id de Meta. Va al `meta`, no al `provider_message_id`: otro espacio. */
  wamid: string | null;
  enviadoEl: Date | null;
}

const ESTADOS = new Set(['sent', 'delivered', 'read', 'failed']);

export async function consultarMensajeDelCanal(
  id: string,
  config: ConsultaDelCanal,
): Promise<MensajeDelCanal | null> {
  const avisar = config.avisar ?? (() => {});
  if (!id.trim()) return null;
  const llamar = config.fetch ?? globalThis.fetch;
  // `baseDeZavu` ya resuelve hasta `/v1`, así que el camino es `/messages/…`.
  const url = `${baseDeZavu(config.apiBase).replace(/\/$/, '')}/messages/${encodeURIComponent(id)}`;
  let respuesta: Response;
  try {
    respuesta = await llamar(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.timeoutMs ?? TIMEOUT_POR_DEFECTO),
    });
  } catch {
    avisar('no se pudo preguntarle a Zavu por ese mensaje');
    return null;
  }
  // Un 404 es definitivo y no merece ruido: el id puede ser de otro proyecto.
  if (respuesta.status === 404) return null;
  if (!respuesta.ok) {
    avisar(`Zavu respondió ${respuesta.status} al pedir el mensaje`);
    return null;
  }
  let cuerpo: unknown;
  try {
    cuerpo = await respuesta.json();
  } catch {
    avisar('Zavu respondió algo que no es JSON');
    return null;
  }
  const m = (cuerpo as { message?: Record<string, unknown> }).message ?? (cuerpo as Record<string, unknown>);
  const direccion = String(m.direction ?? '');
  if (direccion !== 'inbound' && direccion !== 'outbound') {
    avisar('Zavu devolvió un mensaje sin dirección reconocible');
    return null;
  }
  const texto = typeof m.text === 'string' ? m.text : null;
  const cuando = m.createdAt ? new Date(String(m.createdAt)) : null;
  const estado = String(m.status ?? '');
  return {
    providerMessageId: String(m.id ?? id),
    direction: direccion,
    from: typeof m.from === 'string' ? m.from : null,
    to: typeof m.to === 'string' ? m.to : null,
    channel: typeof m.channel === 'string' ? m.channel : null,
    // La MISMA tabla que usa el camino de entrada: si el eco clasificara los
    // tipos distinto, un audio importado y uno recibido se verían distintos.
    type: TIPOS[String(m.messageType ?? 'text')] ?? 'texto',
    text: texto,
    status: ESTADOS.has(estado) ? (estado as MensajeDelCanal['status']) : null,
    wamid: typeof m.providerMessageId === 'string' ? m.providerMessageId : null,
    enviadoEl: cuando && Number.isFinite(cuando.getTime()) ? cuando : null,
  };
}
