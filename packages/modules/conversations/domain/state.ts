// Reglas puras de la bandeja (SPEC §11): máquina de estados de la
// conversación, progresión de entrega y ventana de 24 h. Sin base de datos.

export const CONVERSATION_STATES = ['new', 'open', 'pending', 'resolved', 'snoozed'] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

const TRANSITIONS: Record<ConversationState, ConversationState[]> = {
  new: ['open', 'resolved'],            // tomarla, o cerrarla directo (spam)
  open: ['pending', 'resolved', 'snoozed'],
  pending: ['open', 'resolved', 'snoozed'],
  resolved: ['open', 'new'],            // reapertura: solo al recibir mensaje
  snoozed: ['open', 'resolved', 'new'], // despierta por fecha o por mensaje (sin dueño → cola)
};

export function assertConversationTransition(from: ConversationState, to: ConversationState): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Transición de conversación inválida: ${from} → ${to}`);
  }
}

export const DELIVERY_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const DELIVERY_ORDER: Record<Exclude<DeliveryStatus, 'failed'>, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

/**
 * La entrega solo avanza (queued → sent → delivered → read); Meta puede
 * saltarse pasos, pero nunca retrocede. `failed` cierra desde cualquier
 * estado no terminal y es terminal.
 */
export function assertDeliveryAdvance(from: DeliveryStatus, to: DeliveryStatus): void {
  if (from === 'failed' || from === 'read') {
    throw new Error(`La entrega ya terminó en "${from}"; no cambia más.`);
  }
  if (to === 'failed') return;
  if (DELIVERY_ORDER[to] <= DELIVERY_ORDER[from as Exclude<DeliveryStatus, 'failed'>]) {
    throw new Error(`La entrega no retrocede: ${from} → ${to}.`);
  }
}

/** Ventana de 24 h de WhatsApp desde el último mensaje ENTRANTE (SPEC §11). */
export function isWithin24hWindow(lastInboundAt: Date | null, now: Date = new Date()): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < 24 * 60 * 60 * 1000;
}

/**
 * Cada canal de Meta tiene su ventana desde el último entrante (#74). Las tres
 * son de 24 h, pero son reglas SEPARADAS: si Meta mueve una, se toca acá y no
 * en diez `if`. `null` = sin ventana, porque el canal es nuestro.
 *
 * Fuera de ventana, cada canal tiene su salida: en WhatsApp la plantilla
 * aprobada (#44); en Instagram y Messenger, las etiquetas de mensaje —entre
 * ellas la de agente humano, que estira a 7 días— que aún no implementamos.
 */
export const VENTANA_HORAS: Record<string, number | null> = {
  whatsapp: 24,
  instagram: 24,
  messenger: 24,
  webchat: null,
  simulador: null,
};

/**
 * Canales que salen por un proveedor externo y por lo tanto pasan por la
 * cola `outbound`. El webchat y el simulador se entregan DENTRO de la app:
 * ahí escribir la fila del mensaje ES entregarlo.
 *
 * La distinción importaba poco cuando el único canal con proveedor era
 * WhatsApp. Con Instagram y Messenger (#74), un `=== 'whatsapp'` deja los
 * otros dos marcados como enviados sin que salga nada.
 */
export const CANALES_POR_PROVEEDOR = ['whatsapp', 'instagram', 'messenger'] as const;

export function salePorProveedor(canal: string): boolean {
  return (CANALES_POR_PROVEEDOR as readonly string[]).includes(canal);
}

export function isWithinWindow(
  channel: string,
  lastInboundAt: Date | null,
  now: Date = new Date(),
): boolean {
  const horas = VENTANA_HORAS[channel];
  if (horas === null || horas === undefined) return true;
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < horas * 60 * 60 * 1000;
}
