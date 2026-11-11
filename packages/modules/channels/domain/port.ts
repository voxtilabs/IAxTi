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
  /**
   * Quién atiende esta cuenta: `zavu`, `zernio`, … (ADR-0032).
   *
   * Las cuentas anteriores a la migración `0006` lo traen en
   * `PROVEEDOR_POR_OMISION`, que es el mismo valor que puso el `DEFAULT`.
   *
   * Opcional en el TIPO, a propósito: decenas de pruebas arman la cuenta a
   * mano, y una cuenta sin proveedor resuelve a `zavu`, que es exactamente lo
   * que pasaba antes de la ADR-0032. Lo que sale de la base siempre lo trae:
   * `rowToAccount` lo completa.
   */
  provider?: string;
  config: Record<string, unknown>;
}

/** Mensaje saliente ya normalizado que el adaptador debe entregar. */
export interface OutboundMessage {
  to: string; // teléfono E.164 o id del canal
  type: string;
  body?: string;
  /**
   * NUESTRO id del mensaje, para que el adaptador pueda pedir idempotencia al
   * proveedor (#585).
   *
   * Va en el puerto y no solo en los datos del job porque es parte de «qué
   * mensaje se está entregando», no del transporte: cualquier adaptador que
   * tenga una llave de idempotencia la necesita. Llegaba al adaptador de
   * casualidad —`deliverOutbound` esparce los datos del job— pero no estaba en
   * el tipo, así que nadie sabía que podía usarlo.
   */
  messageId?: string;
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
  /**
   * El hilo de ESTE proveedor para este destinatario (ADR-0033): el id de la
   * conversación del lado del proveedor, cuando el proveedor manda por hilo
   * y no por destinatario — Zernio hoy. Lo pone el worker antes de `send`,
   * leyéndolo de la tabla `channel_threads`; el adaptador no lo busca solo.
   *
   * Opcional a propósito: Zavu y webchat no conocen el concepto, y un envío
   * sin hilo conocido es válido (el adaptador crea la conversación, hoy
   * obligado a ir con plantilla).
   */
  providerThreadId?: string;
}

/** Mensaje entrante ya normalizado: la forma que entiende la cola inbound. */
export interface NormalizedInbound {
  phone: string;
  type: string;
  body?: string;
  attachments?: unknown[];
  providerMessageId: string;
  timestamp?: string;
  /**
   * El hilo del proveedor por donde llegó (ADR-0033): cada webhook de Zernio
   * trae el `conversationId` de su lado, así que la correspondencia se aprende
   * sola en cada mensaje del cliente. Lo recuerda el camino de entrada; el
   * adaptador solo lo reporta.
   *
   * Opcional: los proveedores que mandan por destinatario (Zavu) no tienen
   * nada que decir acá.
   */
  providerThreadId?: string;
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
  /**
   * Quién atiende, no por dónde (ADR-0032). `kind` es el canal —whatsapp,
   * instagram— y esto es la empresa que lo sirve: `zavu`, `zernio`, `webchat`.
   *
   * Opcional por los adaptadores que ya existen: sin esto, `zavu` queda `zavu`
   * y el simulador y el webchat se nombran solos. Que el valor por omisión sea
   * EL_DE_SIEMPRE y no «el primero que registre» es a propósito: un registro
   * que se resuelve por orden de arranque se comporta distinto según quién
   * levantó primero, y eso no se puede depurar.
   */
  proveedor?: string;
  /**
   * ADR-0033: si el proveedor manda por hilo y el envío tuvo que CREAR uno,
   * lo devuelve en `providerThreadId` para que el worker lo recuerde. Los
   * proveedores que mandan por destinatario no lo traen, y eso también está
   * bien: solo existe cuando el adaptador sabe algo nuevo.
   */
  send(account: ChannelAccountRef, message: OutboundMessage): Promise<{ providerMessageId: string; providerThreadId?: string }>;
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, secret: string): boolean;
  normalize(payload: unknown): NormalizedInbound[];
  /** Solo los canales que tienen plantillas (hoy WhatsApp). */
  plantillas?: PuertoDePlantillas;
}

/**
 * El proveedor de las cuentas que nacieron antes de la ADR-0032.
 *
 * Es el mismo valor que pone la migración `0006` como `DEFAULT`, y están
 * atados: si acá dijera otra cosa, una cuenta vieja resolvería a un adaptador
 * distinto del que la atendió siempre.
 */
export const PROVEEDOR_POR_OMISION = 'zavu';

/** `zavu:whatsapp`. Que la clave sea legible importa cuando falla el arranque. */
const clave = (proveedor: string, kind: ChannelKind) => `${proveedor}:${kind}`;

function nombreDe(provider: ChannelProvider): string {
  return provider.proveedor ?? PROVEEDOR_POR_OMISION;
}

// Registro de adaptadores: Zavu (#42) —que sirve whatsapp, instagram y
// messenger con el mismo código— y webchat (#46) se enchufan aquí.
//
// La clave es (proveedor, canal) desde la ADR-0032. Antes era solo el canal, y
// eso hacía que `registerProvider` fuera un cerrojo global: no se podía
// registrar un segundo adaptador de WhatsApp ni para probarlo, así que elegir
// proveedor era una decisión del despliegue entero.
const providers = new Map<string, ChannelProvider>();

export function registerProvider(provider: ChannelProvider): void {
  const k = clave(nombreDe(provider), provider.kind);
  // Rechaza el duplicado EXACTO, no cualquier segundo adaptador del canal.
  if (providers.has(k)) {
    throw new Error(`Ya hay un adaptador registrado para «${k}».`);
  }
  providers.set(k, provider);
}

/**
 * El adaptador que atiende a esta cuenta.
 *
 * Recibe la cuenta y no el canal porque el proveedor es de la cuenta. En cinco
 * de los siete llamadores la cuenta ya estaba a mano y solo se le pasaba
 * `.kind`; esto usa lo que ya tenían.
 */
export function proveedorDe(cuenta: Pick<ChannelAccountRef, 'kind'> & { provider?: string | null }): ChannelProvider | null {
  return providers.get(clave(cuenta.provider ?? PROVEEDOR_POR_OMISION, cuenta.kind)) ?? null;
}

/**
 * El adaptador POR OMISIÓN de un canal, para los dos llamadores que no tienen
 * una cuenta a mano: el aviso de transportistas y el respaldo del webhook.
 *
 * Resuelve al proveedor por omisión declarado, NO a «el único que hay». La
 * diferencia aparece el día que haya dos: la versión vieja devolvía
 * silenciosamente el que estuviera, que podía ser el de prueba.
 */
export function getProvider(kind: ChannelKind): ChannelProvider | null {
  return providers.get(clave(PROVEEDOR_POR_OMISION, kind)) ?? null;
}

/** Qué hay registrado, para la verificación del arranque. */
export function proveedoresRegistrados(): string[] {
  return [...new Set([...providers.values()].map(nombreDe))].sort();
}

/** Solo para tests: el registro es estado de proceso. */
export function resetProviders(): void {
  providers.clear();
}
