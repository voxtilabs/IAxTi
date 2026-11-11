import type IORedis from 'ioredis';
import { proveedorDe } from '@iaxti/module-channels';
import type { ChannelAccountRef } from '@iaxti/module-channels';
import { enteroDeEntorno } from '@iaxti/core';

// Salida de WhatsApp (#43): la cola `outbound` con rate limit POR NÚMERO y
// causas de fallo legibles — un "failed" sin explicación mata la confianza.

/**
 * Causas traducidas a voz Pulso. Los numéricos son de la Cloud API de Meta y
 * siguen llegando cuando el proveedor los pasa; los de texto son los que
 * inventa Zavu. Un "failed" sin explicación mata la confianza.
 */
/**
 * La frase exacta que queda guardada cuando el canal llegó a su tope.
 *
 * Es una constante y no un literal suelto porque **otro módulo la busca**: una
 * campaña necesita saber si sus mensajes están siendo rechazados por tope para
 * dejar de fabricar más (#609). Si esto fuera prosa escrita a mano acá y una
 * consulta con `ILIKE '%tope diario%'` allá, el día que alguien mejore la
 * redacción el corte dejaría de dispararse —sin ruido, sin error, sin prueba
 * roja— y la campaña volvería a encolar mensajes para un canal lleno.
 */
export const MOTIVO_TOPE_DIARIO =
  'El canal llegó a su tope diario de mensajes. Lo que falta puede salir mañana.';

export const CAUSAS_META: Record<number | string, string> = {
  131026: 'El número no tiene WhatsApp.',
  131047: 'Pasaron más de 24 horas desde su último mensaje: solo salen plantillas aprobadas.',
  131048: 'WhatsApp pausó los envíos de este número por límite de spam.',
  131049: 'Meta descartó el mensaje para proteger la experiencia del cliente.',
  100: 'El mensaje no pasó la validación de WhatsApp.',
  368: 'La cuenta de WhatsApp está temporalmente bloqueada por políticas.',
  whatsapp_window_closed:
    'Pasaron más de 24 horas desde su último mensaje: solo salen plantillas aprobadas.',
  url_shortener_blocked: 'Los acortadores de enlaces están bloqueados: manda el enlace completo.',
  url_not_verified: 'Ese enlace todavía no está verificado para enviarse por este canal.',
  pending_url_verification: 'El enlace quedó esperando verificación antes de poder enviarse.',
  destination_not_verified: 'Ese destinatario no está verificado todavía en la cuenta.',
  /**
   * La llave de prueba solo alcanza a la gente del equipo (#596).
   *
   * Zavu lo responde así, textual: «Sandbox mode: a test key only reaches the
   * phone numbers of people on your team. Send to one of those, or use a live
   * API key.» Va acá y no en la tabla por status porque es lo ÚNICO que
   * distingue este 403 de un 403 por credencial mala, y los dos mandan a
   * arreglar cosas opuestas.
   */
  /**
   * El tope diario del canal (#609).
   *
   * No estaba, y su ausencia tenía dos consecuencias que se suman. La primera:
   * el motivo que leía la persona salía del `fallback` —«WhatsApp no aceptó el
   * envío. Reintenta en unos minutos»— que es consejo EQUIVOCADO: reintentar en
   * unos minutos no sirve, el tope se libera mañana. La segunda: sin una causa
   * reconocible, una campaña no podía enterarse de que el canal se llenó, y por
   * ahí pasaba lo de #609 — campaña «enviada» de 900 con 650 personas que nunca
   * recibieron nada.
   */
  DAILY_LIMIT_EXCEEDED: MOTIVO_TOPE_DIARIO,
  'Sandbox mode':
    'Este canal está conectado con una llave de prueba, y esas solo alcanzan a los números ' +
    'del equipo en el proveedor. Agrega ese número al equipo, o conecta el canal con una ' +
    'llave de producción.',
  daily_limit_exceeded: 'Se alcanzó el tope de envíos del día; sigue mañana.',
  a2p_limit_exceeded: 'Se alcanzó el tope mensual de mensajes del plan.',
  rate_limited: 'El proveedor pidió bajar el ritmo; se reintenta solo.',
};

export function causaLegible(codigo?: number | string, fallback?: string): string {
  return (
    (codigo !== undefined && CAUSAS_META[codigo]) ||
    fallback ||
    'WhatsApp no aceptó el envío. Reintenta en unos minutos.'
  );
}

export class RateLimitedError extends Error {
  constructor(public readonly phoneNumberId: string) {
    super('Rate limit del número alcanzado; se reintenta solo.');
  }
}

/**
 * ¿El proveedor dijo que se llenó el tope diario del canal? (#609)
 *
 * Vive aparte de `rechazoPermanente` porque la respuesta no depende del código
 * HTTP: el tope llega como 429, que en cualquier otro caso SÍ merece los cinco
 * intentos con backoff. Acá no: el tope no se libera en treinta segundos, se
 * libera al día siguiente. Reintentar es gastar cinco intentos por mensaje —con
 * 650 mensajes son 3.250 llamadas inútiles— y, lo peor, retrasar horas el
 * momento en que alguien se entera de qué pasó.
 */
export function esTopeDiario(cuerpo: string): boolean {
  return /DAILY_LIMIT_EXCEEDED|daily limit (?:exceeded|reached)/i.test(cuerpo ?? '');
}

/**
 * Lo que NO se arregla reintentando.
 *
 * Cinco intentos con backoff exponencial es lo correcto para un 429 o un 503:
 * el proveedor está saturado y se recupera. Pero una variable de entorno que
 * falta, una API key mala o un emisor que no existe no aparecen solos. Sin
 * distinguir, el mensaje se queda «enviando» varias horas y recién entonces el
 * vendedor se entera de que el canal está mal conectado — y lo que lee es el
 * texto crudo del sistema. Las dos cosas se arreglan acá: se rechaza al primer
 * intento y con una frase que dice qué hacer.
 *
 * `detalle` es para el log —el cuerpo que devolvió el proveedor, que es lo que
 * sirve para depurar— y `message` es lo que lee una persona. Ahí no van
 * nombres de campos internos.
 */
export class ErrorPermanente extends Error {
  readonly permanente = true as const;
  constructor(
    message: string,
    public readonly detalle?: string,
  ) {
    super(message);
    this.name = 'ErrorPermanente';
  }
}

/**
 * Por qué no basta `instanceof`: el worker importa el paquete COMPILADO y los
 * tests importan la fuente, así que pueden convivir dos copias de la clase.
 * Un `instanceof` contra la otra copia da false, el error se trata como
 * transitorio y vuelve a reintentarse cinco veces — exactamente lo que este
 * cambio existe para arreglar. La marca en la instancia sobrevive al cruce.
 */
export function esPermanente(err: unknown): err is ErrorPermanente {
  if (err instanceof ErrorPermanente) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { permanente?: unknown }).permanente === true
  );
}

/**
 * Un rechazo HTTP del canal: ¿vale la pena volver a intentarlo?
 *
 * 429 y 5xx sí — saturado o caído, se recupera. El resto de los 4xx no: 401 es
 * la credencial mala, 400 es la carga mala, 404 es el emisor que ya no existe.
 * El 408 es la excepción entre los 4xx: es un timeout, no un problema con lo
 * que mandamos.
 */
export function rechazoPermanente(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429 && status !== 408;
}

/**
 * Qué se le dice a una persona cuando el canal rechaza para siempre. El código
 * HTTP no se muestra: no le sirve a quien está atendiendo, y el cuerpo crudo
 * del proveedor va al log.
 */
/**
 * El código que el proveedor metió en el cuerpo del rechazo.
 *
 * `CAUSAS_META` existe desde #43 para traducir estos códigos a una frase que
 * una persona entiende, pero el camino de envío nunca los sacaba del cuerpo:
 * el JSON crudo del proveedor se iba tal cual a la bandeja y la tabla se usaba
 * solo para los webhooks de estado. Así, un «ventana cerrada» —que ya estaba
 * escrito en español— llegaba al vendedor como
 * `{"error":{"code":"whatsapp_window_closed"}}`.
 *
 * Se leen las formas que Zavu y Meta usan, y si ninguna calza se busca
 * cualquier clave conocida dentro del texto: es un cuerpo de error, no un
 * contrato, y cambia sin avisar.
 */
export function codigoDelProveedor(cuerpo: string): number | string | undefined {
  if (!cuerpo) return undefined;
  try {
    const j = JSON.parse(cuerpo) as Record<string, unknown>;
    const candidatos: unknown[] = [
      (j.error as { code?: unknown } | undefined)?.code,
      j.code,
      (Array.isArray(j.errors) ? (j.errors[0] as { code?: unknown } | undefined)?.code : undefined),
      (j.meta as { code?: unknown } | undefined)?.code,
    ];
    for (const c of candidatos) {
      if ((typeof c === 'string' && c) || typeof c === 'number') {
        if (CAUSAS_META[c] !== undefined) return c;
      }
    }
  } catch {
    // Un cuerpo que no es JSON es perfectamente posible (HTML de un proxy,
    // texto pelado): se sigue al barrido de abajo.
  }
  return Object.keys(CAUSAS_META).find((k) => cuerpo.includes(k));
}

/**
 * ¿El proveedor dijo que el emisor está desactivado? (#1178)
 *
 * Vive aparte y mira el CUERPO por la misma razón que `esTopeDiario`: la
 * respuesta no depende del código HTTP. Zavu manda 403 para dos cosas que no
 * se parecen —el emisor desactivado y el destino no permitido— y lo que las
 * distingue está en el texto.
 *
 * Medido contra la API de producción el 02-11, mandando el mismo cuerpo a tres
 * emisores del mismo proyecto:
 *
 *     {"code":"forbidden","message":"This connection is deactivated. Activate
 *      it from Accounts in the dashboard, or with POST /v1/senders/{senderId}/
 *      channels/{channel}/activate, to send and receive on this channel."}
 *
 * Se busca solo `deactivated`, que es el término que el proveedor usa como
 * marcador, no la frase entera: una frase entera se rompe con la primera
 * reescritura de su documentación y eso devuelve al mensaje equivocado sin que
 * nada se ponga rojo. Si el marcador no aparece, cae al genérico del 403, que
 * es el comportamiento seguro: decir menos, no decir otra cosa.
 */
export function esEmisorDesactivado(cuerpo: string): boolean {
  return /deactivated|desactivad/i.test(cuerpo ?? '');
}

/**
 * El cuerpo es OBLIGATORIO y no opcional a propósito (#1178).
 *
 * Con un parámetro opcional, un llamador que no lo pase recibe el mensaje
 * equivocado y nada se queja: ni el compilador ni una prueba. Es exactamente
 * la forma del defecto que este repo nombra declarado-y-no-aplicado, y acá se
 * puede cerrar gratis — hacerlo obligatorio pone la omisión en `typecheck`.
 *
 * Y conceptualmente es lo correcto: un rechazo no es un número, es un número
 * con un motivo. La lección de #596 y de este issue es la misma —del status
 * solo no se puede decidir qué decirle a una persona—, así que la firma lo
 * dice.
 */
export function mensajeDeRechazo(status: number, cuerpo: string): string {
  if (status === 401) {
    return 'El canal rechazó nuestras credenciales. Un administrador tiene que reconectarlo en Canales.';
  }
  if (status === 403) {
    /**
     * 401 y 403 NO son lo mismo, y confundirlos costó tres días (#596).
     *
     * 401 es «no sé quién eres»: la credencial está mala y hay que reconectar.
     * 403 es «sé quién eres y esto no lo puedes hacer»: la credencial está
     * PERFECTA y el problema es el destino, el número o el permiso.
     *
     * Estaban juntos, así que un rechazo de sandbox —«a test key only reaches
     * the phone numbers of people on your team»— se leía como «el canal rechazó
     * nuestras credenciales, reconéctalo». O sea que el producto mandaba a
     * reconectar un canal sano, y reconectarlo no arreglaba nada, así que se
     * hacía otra vez. Es la peor clase de mensaje: no solo no ayuda, manda en
     * la dirección contraria.
     *
     * **Y este 403 tenía el mismo defecto un nivel más abajo (#1178):** daba
     * por hecho que un 403 siempre es «ese destino no». El emisor desactivado
     * también llega como 403, y mandaba a revisar el número del contacto, la
     * ventana de 24 h y los permisos del destino cuando lo que faltaba era un
     * clic en el panel del proveedor. Un solo mensaje para dos causas tiene que
     * estar equivocado en una.
     */
    if (esEmisorDesactivado(cuerpo)) {
      return (
        'Este emisor está desactivado en Zavu. Actívalo en la cuenta del proveedor ' +
        'y vuelve a intentar: la credencial y el número están bien.'
      );
    }
    return (
      'El canal no tiene permitido escribirle a ese número. La credencial está bien: ' +
      'lo que falta es el permiso para ese destino.'
    );
  }
  if (status === 404) {
    return 'El emisor de este canal ya no existe en el proveedor. Reconéctalo en Canales.';
  }
  if (status === 413) {
    return 'El adjunto pesa más de lo que este canal acepta. Mándalo más liviano.';
  }
  return 'El canal rechazó el envío y no lo va a aceptar reintentando. Revisa el número del contacto y la conexión del canal.';
}

/**
 * Cupo por número y por segundo (token bucket simple en Redis). Meta admite
 * ráfagas mucho mayores; partimos conservadores y configurable por env.
 */
export async function checkNumberRateLimit(
  redis: IORedis,
  phoneNumberId: string,
  maxPorSegundo = enteroDeEntorno('WHATSAPP_MSGS_PER_SECOND', 10),
  /**
   * El instante que define la ventana. Existe para los tests: la ventana
   * dura un segundo, y una prueba que hace cuatro llamadas confiando en que
   * caigan todas en el mismo segundo se pone roja sola cuando la máquina va
   * cargada — el contador se reinicia a mitad de camino y el cupo no corta.
   */
  ahora = Date.now(),
): Promise<void> {
  const bucket = Math.floor(ahora / 1000);
  const key = `wa:rate:${phoneNumberId}:${bucket}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 2);
  if (n > maxPorSegundo) throw new RateLimitedError(phoneNumberId);
}

export interface OutboundJobData {
  moduleId?: 'whatsapp';
  tenantId: string;
  messageId: string;
  channelAccountId: string;
  /**
   * El hilo del proveedor (ADR-0033). NO viaja en el job de la cola: lo pone
   * el worker al despachar, leído de `channel_threads` bajo el candado del
   * destinatario. Un hilo guardado en Redis se quedaría viejo entre
   * reintentos.
   */
  providerThreadId?: string;
  to: string;
  body?: string;
  type?: string;
  /**
   * Los adjuntos ya listos para el proveedor (#458): URL que puede bajar,
   * nombre y tipo. Quien despacha los firma; acá solo viajan.
   */
  attachments?: Array<{ url: string; filename?: string; contentType?: string }>;
  /**
   * ¿Lo inicia el NEGOCIO (automatización, secuencia, campaña) o es una
   * persona respondiendo en la bandeja? De esto dependen el horario de
   * silencio y la pausa por calidad (SPEC §8, #45).
   *
   * OBLIGATORIO a propósito: era opcional, y el cableado de automatizaciones
   * simplemente no lo mandaba. El motor documentaba "la cola aplica el
   * silencio" y la cola nunca se enteraba de que el envío era del negocio,
   * así que una automatización de las 3am salía a las 3am.
   */
  initiatedByBusiness: boolean;
  /**
   * Mensaje transaccional (ADR-0016): lo dispara una acción del cliente y su
   * contenido es la constancia de esa acción — hoy, el comprobante de pago.
   * Se salta el horario de silencio y NADA más.
   *
   * Opcional a propósito, al revés que `initiatedByBusiness`. Ese era
   * opcional y olvidarlo hacía salir una automatización a las 3am, así que
   * se volvió obligatorio. Con este, olvidarlo significa "no es
   * transaccional": el mensaje se difiere. El descuido cae del lado de la
   * regla, no del lado de saltársela.
   */
  transaccional?: boolean;
  /** Datos propios del canal: hoy, la plantilla aprobada (#44). */
  extra?: Record<string, unknown>;
  requestId?: string;
}

/**
 * Entrega un saliente por el adaptador del canal. Lanza para que BullMQ
 * reintente (backoff exponencial ya configurado en la cola); el worker
 * decide cuándo el fallo es definitivo y lo marca con causa legible.
 */
export async function deliverOutbound(
  account: ChannelAccountRef,
  data: OutboundJobData,
  redis: IORedis,
): Promise<{ providerMessageId: string; providerThreadId?: string }> {
  // El de la CUENTA, no el del canal (ADR-0032): dos cuentas de WhatsApp
  // pueden ir por proveedores distintos.
  const provider = proveedorDe(account);
  if (!provider) {
    // Un canal sin adaptador es un bug de configuración del módulo, no un
    // temporal: reintentarlo cinco veces solo retrasa la noticia.
    throw new ErrorPermanente(
      'Este canal no está disponible para enviar. Avísanos: es una configuración que tenemos que corregir nosotros.',
      `No hay adaptador para el canal ${account.kind}.`,
    );
  }
  const phoneNumberId = (account.config.phoneNumberId as string) ?? account.id;
  await checkNumberRateLimit(redis, phoneNumberId);
  return provider.send(account, {
    to: data.to,
    type: data.type ?? 'texto',
    body: data.body,
    /**
     * NUESTRO id, para que el adaptador pida idempotencia al proveedor (#585).
     *
     * Faltaba, y el campo salía undefined del POST. Lo que eso significa lo
     * dice el comentario de `zavu.ts`: si Zavu acepta el mensaje y la
     * respuesta se pierde —un timeout, la red—, BullMQ reintenta y el
     * cliente recibe el mismo mensaje dos veces. Se paga dos veces y se
     * gastan dos del tope diario.
     *
     * El tipo lo declara desde que alguien notó que llegaba «de casualidad»
     * porque `deliverOutbound` esparcía el job entero; al pasar a construir
     * el objeto campo por campo, este se quedó afuera.
     */
    messageId: data.messageId,
    ...(data.attachments?.length ? { attachments: data.attachments } : {}),
    // La plantilla aprobada, si el mensaje sale con una (#44). El adaptador
    // decide cómo la manda; acá solo viaja.
    ...(data.extra ? { extra: data.extra } : {}),
    // El hilo del proveedor, si el worker lo conoce (ADR-0033). Zavu lo ignora.
    ...(data.providerThreadId ? { providerThreadId: data.providerThreadId } : {}),
  });
}
