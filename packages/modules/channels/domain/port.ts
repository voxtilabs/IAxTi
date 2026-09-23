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
  /**
   * Los adjuntos, ya listos para que el proveedor los baje (#458).
   *
   * Era `unknown[]` y nadie los miraba: el campo existía en el puerto y el
   * adaptador no lo traducía, así que un mensaje con foto salía sin la
   * foto. Tiparlo es lo que obliga a que quien despacha entregue una URL
   * de verdad, no una llave privada de R2 que el proveedor no puede leer.
   */
  attachments?: Array<{ url: string; filename?: string; contentType?: string }>;
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
/**
 * Una plantilla tal como la ve el proveedor (#159).
 *
 * Los nombres son los NUESTROS, no los de nadie: el estado y la categoría
 * ya los traduce cada adaptador. Un campo con el nombre del proveedor acá
 * sería la misma dependencia por otra puerta.
 */
export interface PlantillaDelProveedor {
  id: string;
  name: string;
  language: string;
  /** null cuando el proveedor todavía no dice nada. */
  status: string | null;
  category: string;
  /** Lo que dice Meta, que puede ir por delante del estado del proveedor. */
  estadoDeMeta?: string;
  /** Por qué la rechazó. Es lo único accionable de un rechazo. */
  motivoDeRechazo?: string;
}

/**
 * Las plantillas, por el mismo puerto que los mensajes (#159).
 *
 * Los mensajes ya eran portables —`send`, `verifyWebhook`, `normalize`— y
 * las plantillas no: la API y el worker llamaban a `crearEnZavu`,
 * `enviarARevisionEnZavu` y `listarEnZavu` POR SU NOMBRE. O sea que salir
 * del intermediario era una línea en la mitad del producto y una reescritura
 * en la otra mitad, y eso no se ve hasta que hay que hacerlo.
 *
 * Es opcional: el webchat y el simulador no tienen plantillas, y un canal
 * sin esto simplemente no las ofrece.
 */
export interface PuertoDePlantillas {
  crear(
    cuenta: ChannelAccountRef,
    input: {
      name: string;
      language: string;
      body: string;
      category: string;
      footer?: string | null;
      buttons?: Array<{ type: string; text: string }>;
    },
  ): Promise<PlantillaDelProveedor>;
  enviarARevision(
    cuenta: ChannelAccountRef,
    input: { templateId: string; category: string },
  ): Promise<PlantillaDelProveedor>;
  listar(cuenta: ChannelAccountRef): Promise<PlantillaDelProveedor[]>;
}

export interface ChannelProvider {
  kind: ChannelKind;
  send(account: ChannelAccountRef, message: OutboundMessage): Promise<{ providerMessageId: string }>;
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, secret: string): boolean;
  normalize(payload: unknown): NormalizedInbound[];
  /** Solo los canales que tienen plantillas (hoy WhatsApp). */
  plantillas?: PuertoDePlantillas;
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
