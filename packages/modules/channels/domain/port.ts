// El puerto ChannelProvider (#41, SPEC §12): la bandeja y la IA no saben de
// dónde viene un mensaje. Instagram o Messenger (#74) son SOLO un
// adaptador nuevo que implementa esta interfaz. Puro: sin base ni HTTP.

export const CHANNEL_KINDS = ['whatsapp', 'webchat', 'instagram', 'messenger', 'simulador'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const CHANNEL_STATES = ['connecting', 'active', 'degraded', 'disconnected'] as const;
export type ChannelState = (typeof CHANNEL_STATES)[number];

const TRANSICIONES: Record<ChannelState, ChannelState[]> = {
  connecting: ['active', 'disconnected'],
  active: ['degraded', 'disconnected'],
  degraded: ['active', 'disconnected'],
  disconnected: ['connecting'],
};

export function assertChannelTransition(from: ChannelState, to: ChannelState): void {
  if (!TRANSICIONES[from]?.includes(to)) {
    throw new Error(`Transición de canal inválida: ${from} → ${to}`);
  }
}

/** Cuenta de canal SIN secretos: las credenciales van referenciadas. */
export interface ChannelAccountRef {
  id: string;
  tenantId: string;
  kind: ChannelKind;
  name: string;
  state: ChannelState;
  /** Nombre de la variable/secreto donde vive la credencial — jamás en claro. */
  credentialRef: string | null;
  config: Record<string, unknown>;
}

/** Mensaje saliente ya normalizado que el adaptador debe entregar. */
export interface OutboundMessage {
  to: string; // teléfono E.164 o id del canal
  type: string;
  body?: string;
  attachments?: unknown[];
  /** Datos propios del canal (plantilla, botones, …). */
  extra?: Record<string, unknown>;
}

/** Mensaje entrante ya normalizado: la forma que entiende la cola inbound. */
export interface NormalizedInbound {
  phone: string;
  type: string;
  body?: string;
  attachments?: unknown[];
  providerMessageId: string;
  timestamp?: string;
}

/**
 * EL contrato de todo canal. `verifyWebhook` corre antes que nada y sobre
 * el cuerpo CRUDO; `normalize` traduce el payload del proveedor a la forma
 * única; `send` entrega y devuelve el id del proveedor.
 */
export interface ChannelProvider {
  kind: ChannelKind;
  send(account: ChannelAccountRef, message: OutboundMessage): Promise<{ providerMessageId: string }>;
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, secret: string): boolean;
  normalize(payload: unknown): NormalizedInbound[];
}

// Registro de adaptadores: Zavu (#42) —que sirve whatsapp, instagram y
// messenger con el mismo código— y webchat (#46) se enchufan aquí.
const providers = new Map<ChannelKind, ChannelProvider>();

export function registerProvider(provider: ChannelProvider): void {
  if (providers.has(provider.kind)) {
    throw new Error(`Ya hay un adaptador registrado para "${provider.kind}".`);
  }
  providers.set(provider.kind, provider);
}

export function getProvider(kind: ChannelKind): ChannelProvider | null {
  return providers.get(kind) ?? null;
}

/** Solo para tests: el registro es estado de proceso. */
export function resetProviders(): void {
  providers.clear();
}
