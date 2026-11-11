import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { esPermanente, ErrorPermanente } from '../application/outbound';
import { createZernioProvider } from '../application/zernio';
import { verifyZernioSignature } from '../application/zernio-base';
import type { ChannelAccountRef, OutboundMessage } from '@iaxti/module-channels';

/**
 * El adaptador de Zernio (#1317), medido POR EL PUERTO y no con `curl` (#870):
 * se intercepta `fetch` y se lee la petición HTTP de verdad — la URL, las
 * cabeceras y el cuerpo. Sin red, sin llave real.
 *
 * Las dos piezas que estas pruebas existen para proteger:
 *
 * 1. **La firma cierra, y con la cabecera nueva.** ZernFlow verifica con
 *    `X-Late-Signature`, que el spec de Zernio declara heredada y con fecha de
 *    salida. Copiarlo era un apagón programado, y un apagón que se prueba
 *    verde es peor que uno que no se prueba.
 * 2. **La llave de cada cuenta viaja en SU petición** (ZernFlow #18): el SDK
 *    oficial apila interceptores sobre un cliente global y la última llave
 *    construida gana para todas las peticiones en vuelo. Con dos tenants
 *    mandando a la vez, los mensajes de A salen con la cuenta de B. Es la
 *    regresión que hay que tener cazada ANTES de que exista.
 */

const fetchOriginal = globalThis.fetch;

/** Toda petición que salió, para leerla como el proveedor la recibiría. */
interface Peticion {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let peticiones: Peticion[] = [];

/**
 * Intercepta `fetch` y responde siempre lo mismo. Se responde con la forma
 * REAL de cada ruta (spec v1.527): el envío dentro de un hilo es
 * `{success, data: {messageId, …}}` — no el `data.data` genérico que
 * ZernFlow asume, que es justo el tipo de supuesto que esta suite existe
 * para desarmar.
 */
function interceptar(estado: number, cuerpo: unknown): void {
  peticiones = [];
  globalThis.fetch = (async (entrada: unknown, init?: RequestInit) => {
    peticiones.push({
      url: String(entrada),
      headers: ((init?.headers ?? {}) as Record<string, string>),
      body: init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>),
    });
    return {
      ok: estado < 400,
      status: estado,
      text: async () => JSON.stringify(cuerpo),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.stubEnv('ZERNIO_LLAVE_1', 'llave-de-1');
  vi.stubEnv('ZERNIO_LLAVE_2', 'llave-de-2');
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  vi.unstubAllEnvs();
});

/** La cuenta mínima que el adaptador necesita: llave por referencia + accountId de Zernio. */
const cuentaDe = (n: 1 | 2): ChannelAccountRef => ({
  id: `cuenta-iaxti-${n}`,
  tenantId: `tenant-${n}`,
  kind: 'whatsapp',
  name: `Cuenta ${n}`,
  state: 'active',
  credentialRef: `ZERNIO_LLAVE_${n}`,
  config: { zernioAccountId: `cuenta-de-zernio-${n}` },
});

const mensajeBase = (extra?: Partial<OutboundMessage>): OutboundMessage => ({
  to: '+56911112222',
  type: 'texto',
  body: 'Tu cotización está lista',
  messageId: 'nuestro-id-1',
  ...extra,
});

/** La respuesta 200 de enviar dentro de un hilo. */
const RESPUESTA_DE_ENVIO = {
  success: true,
  data: { messageId: 'wamid.ENVIADO', conversationId: 'hilo-1' },
};

const firmaDe = (cuerpo: string, secreto: string) =>
  createHmac('sha256', secreto).update(cuerpo, 'utf8').digest('hex');

describe('la firma del webhook (#1317)', () => {
  const provider = createZernioProvider('whatsapp');
  const crudo = JSON.stringify({
    id: 'evt-1',
    event: 'message.received',
    message: { id: 'm1', conversationId: 'c1', direction: 'incoming', text: 'hola' },
  });
  const secreto = 'secreto-del-perfil';

  it('una firma válida en X-Zernio-Signature pasa', () => {
    expect(provider.verifyWebhook({ 'x-zernio-signature': firmaDe(crudo, secreto) }, crudo, secreto)).toBe(true);
  });

  it('la cabecera vieja X-Late-Signature, aunque la firma sea correcta, se rechaza', () => {
    // ZernFlow verifica con esta. Si el adaptador la aceptara, el día que
    // Zernio cumpla lo que su spec promete («se quitarán en una versión
    // mayor») quedamos aceptando nada — o apagados, según cómo se mire.
    expect(provider.verifyWebhook({ 'x-late-signature': firmaDe(crudo, secreto) }, crudo, secreto)).toBe(false);
  });

  it('sin firma se rechaza: Zernio la hace opcional, acá no', () => {
    expect(provider.verifyWebhook({}, crudo, secreto)).toBe(false);
  });

  it('sin secreto configurado se rechaza: fallar abierto es la puerta de otro tenant', () => {
    expect(provider.verifyWebhook({ 'x-zernio-signature': firmaDe(crudo, secreto) }, crudo, '')).toBe(false);
  });

  it('un cuerpo re-serializado, con la firma del original, se rechaza', () => {
    // La firma es sobre el cuerpo CRUDO byte a byte. Si la verificación se
    // hiciera sobre el objeto parseado, esta entraría: mismo JSON, otros bytes.
    const reserializado = JSON.stringify(JSON.parse(crudo), null, 2);
    expect(provider.verifyWebhook({ 'x-zernio-signature': firmaDe(crudo, secreto) }, reserializado, secreto)).toBe(false);
  });

  it('una firma de otro largo no tira: se compara el largo antes que el contenido', () => {
    // `timingSafeEqual` tira con largos distintos; que no lo haga es parte
    // del contrato del verificador.
    expect(verifyZernioSignature({ 'x-zernio-signature': 'abcd' }, crudo, secreto)).toBe(false);
    expect(verifyZernioSignature({ 'x-zernio-signature': 'a'.repeat(63) }, crudo, secreto)).toBe(false);
  });
});

describe('la llave de cada cuenta viaja en su propia petición (ZernFlow #18)', () => {
  it('20 envíos alternados entre dos cuentas: cada petición sale con SU authorization', async () => {
    const provider = createZernioProvider('whatsapp');
    interceptar(200, RESPUESTA_DE_ENVIO);

    // Alternados y en paralelo, que es el escenario real: dos tenants con
    // dos workers. La URL lleva el número de envío para poder atribuir cada
    // petición a SU cuenta sin depender del orden en que lleguen.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        provider.send(cuentaDe(i % 2 === 0 ? 1 : 2), mensajeBase({ providerThreadId: `hilo-${i}` })),
      ),
    );

    expect(peticiones).toHaveLength(20);
    for (const p of peticiones) {
      const i = Number(/hilo-(\d+)/.exec(p.url)?.[1] ?? NaN);
      expect(Number.isFinite(i)).toBe(true);
      expect(p.headers.authorization).toBe(i % 2 === 0 ? 'Bearer llave-de-1' : 'Bearer llave-de-2');
    }
  });
});

describe('el 409 de la llave en proceso no se reintenta nunca', () => {
  it('llega una vez, se clasifica permanente y con el mensaje para revisar la conversación', async () => {
    const provider = createZernioProvider('whatsapp');
    interceptar(409, { error: 'The same Idempotency-Key is still processing', code: 'conflict' });

    const error = await provider
      .send(cuentaDe(1), mensajeBase({ providerThreadId: 'hilo-1' }))
      .catch((e: unknown) => e);

    // Una sola petición: el adaptador no reintenta por dentro, ni con esta
    // llave ni con otra. Con otra se arriesga el duplicado.
    expect(peticiones).toHaveLength(1);
    expect(esPermanente(error)).toBe(true);
    expect((error as Error).message).toBe(
      'No sabemos si este mensaje alcanzó a salir. Revisa la conversación antes de volver a enviarlo.',
    );
  });
});

describe('normalize: solo lo que escribió el cliente', () => {
  const provider = createZernioProvider('whatsapp');

  /** Un `message.received` completo, como el spec v1.527 lo declara. */
  const evento = (overrides: Record<string, unknown> = {}) => ({
    id: 'evt-1',
    event: 'message.received',
    message: {
      id: 'interno-1',
      conversationId: 'conv-99',
      platformMessageId: 'wamid.ABC',
      direction: 'incoming',
      text: 'Hola, tengo una duda',
      attachments: [
        { type: 'image', url: 'https://zernio.com/api/v1/whatsapp/media/m1', mimeType: 'image/jpeg' },
      ],
      sender: { phoneNumber: '+56912345678' },
      sentAt: '2026-11-11T12:00:00Z',
    },
    conversation: { id: 'conv-99' },
    account: { id: 'acc-1', accountId: 'acc-1' },
    ...overrides,
  });

  it('un entrante completo se normaliza con su hilo y su adjunto', () => {
    const [m] = provider.normalize(evento());
    expect(m).toBeDefined();
    expect(m.phone).toBe('+56912345678');
    expect(m.providerMessageId).toBe('wamid.ABC');
    expect(m.providerThreadId).toBe('conv-99');
    expect(m.body).toBe('Hola, tengo una duda');
    expect(m.type).toBe('imagen');
    expect(m.attachments).toEqual([
      { url: 'https://zernio.com/api/v1/whatsapp/media/m1', contentType: 'image/jpeg', name: 'image' },
    ]);
  });

  it('sin platformMessageId se usa el id interno del mensaje', () => {
    const sinPlatform = evento();
    delete (sinPlatform.message as Record<string, unknown>).platformMessageId;
    const [m] = provider.normalize(sinPlatform);
    expect(m.providerMessageId).toBe('interno-1');
  });

  it('direction outbound se ignora: si no, cada respuesta nuestra reentra', () => {
    // El diseño del issue decía `outbound`; el spec dice `outgoing`. Se
    // ignoran las dos: lo que importa es que SOLO `incoming` entra.
    expect(provider.normalize(evento({ message: { ...evento().message, direction: 'outbound' } }))).toEqual([]);
    expect(provider.normalize(evento({ message: { ...evento().message, direction: 'outgoing' } }))).toEqual([]);
  });

  it('un mensaje sin teléfono no entra y no se le inventa uno', () => {
    // #1331: Meta está migrando a BSUID y el teléfono es nullable. El
    // contacto falso es peor que el mensaje que no entra; el aviso
    // visible de estos mensajes es de ese issue.
    const sinTelefono = evento();
    (sinTelefono.message as Record<string, unknown>).sender = {
      id: 'BSUID:un-identificador-opaco',
      phoneNumber: null,
    };
    expect(provider.normalize(sinTelefono)).toEqual([]);
  });

  it('un evento que no es message.received no es un mensaje', () => {
    expect(provider.normalize(evento({ event: 'message.sent' }))).toEqual([]);
  });
});

describe('send: por hilo cuando lo hay, con plantilla cuando no', () => {
  it('con hilo manda a la ruta del hilo y con NUESTRO id como Idempotency-Key', async () => {
    const provider = createZernioProvider('whatsapp');
    interceptar(200, RESPUESTA_DE_ENVIO);

    const res = await provider.send(cuentaDe(1), mensajeBase({ providerThreadId: 'hilo-vivo' }));

    expect(peticiones).toHaveLength(1);
    expect(peticiones[0].url).toContain('/v1/inbox/conversations/hilo-vivo/messages');
    expect(peticiones[0].headers['idempotency-key']).toBe('nuestro-id-1');
    expect(peticiones[0].body.accountId).toBe('cuenta-de-zernio-1');
    expect(peticiones[0].body.message).toBe('Tu cotización está lista');
    expect(res.providerMessageId).toBe('wamid.ENVIADO');
  });

  it('con hilo pero sin messageId no se manda: mejor no mandar que duplicar', async () => {
    const provider = createZernioProvider('whatsapp');
    interceptar(200, RESPUESTA_DE_ENVIO);

    const error = await provider
      .send(cuentaDe(1), mensajeBase({ providerThreadId: 'hilo-vivo', messageId: undefined }))
      .catch((e: unknown) => e);

    expect(peticiones).toHaveLength(0);
    expect(esPermanente(error)).toBe(true);
  });

  it('sin hilo y con plantilla crea la conversación y devuelve el hilo nuevo', async () => {
    const provider = createZernioProvider('whatsapp');
    interceptar(201, { success: true, data: { messageId: 'wamid.PRIMERO', conversationId: 'conv-nueva' } });

    const res = await provider.send(
      cuentaDe(1),
      mensajeBase({
        providerThreadId: undefined,
        extra: { plantilla: { name: 'cotizacion', language: 'es_CL', valores: ['Juan', '2'] } },
      }),
    );

    expect(peticiones).toHaveLength(1);
    expect(peticiones[0].url).toContain('/v1/inbox/conversations');
    expect(peticiones[0].url).not.toContain('/messages');
    // La ruta de crear no acepta Idempotency-Key (spec v1.527): el candado
    // por destinatario es del worker (ADR-0033). Acá solo se comprueba que
    // no se manda una llave que la ruta va a ignorar.
    expect(peticiones[0].headers['idempotency-key']).toBeUndefined();
    expect(peticiones[0].body).toEqual({
      accountId: 'cuenta-de-zernio-1',
      participantId: '56911112222',
      templateName: 'cotizacion',
      templateLanguage: 'es_CL',
      templateParams: ['Juan', '2'],
    });
    expect(res).toEqual({ providerMessageId: 'wamid.PRIMERO', providerThreadId: 'conv-nueva' });
  });

  it('sin hilo y sin plantilla no se hace NINGUNA petición', async () => {
    const provider = createZernioProvider('whatsapp');
    interceptar(200, RESPUESTA_DE_ENVIO);

    const error = await provider.send(cuentaDe(1), mensajeBase({ providerThreadId: undefined })).catch((e: unknown) => e);

    expect(peticiones).toHaveLength(0);
    expect(esPermanente(error)).toBe(true);
    expect((error as Error).message).toBe(
      'No hay conversación abierta con este contacto; un mensaje fuera de una conversación tiene que ir con plantilla.',
    );
  });

  it('sin la cuenta de Zernio asignada, el error dice qué hacer y no toca la red', async () => {
    const provider = createZernioProvider('whatsapp');
    interceptar(200, RESPUESTA_DE_ENVIO);
    const incompleta = { ...cuentaDe(1), config: {} };

    const error = await provider.send(incompleta, mensajeBase()).catch((e: unknown) => e);

    expect(peticiones).toHaveLength(0);
    expect(error).toBeInstanceOf(ErrorPermanente);
  });
});

describe('la clasificación de los rechazos', () => {
  it('404 en el hilo: permanente, con el marcador que #1334 usa para reconciliar', async () => {
    const provider = createZernioProvider('whatsapp');
    interceptar(404, { error: 'Conversation not found', code: 'not_found' });

    const error = (await provider
      .send(cuentaDe(1), mensajeBase({ providerThreadId: 'hilo-muerto' }))
      .catch((e: unknown) => e)) as ErrorPermanente;

    expect(esPermanente(error)).toBe(true);
    expect(error.detalle ?? '').toMatch(/^hilo_vencido/);
  });

  it('429 y 503 NO son permanentes: los reintenta BullMQ con su backoff', async () => {
    const provider = createZernioProvider('whatsapp');
    for (const estado of [429, 503]) {
      interceptar(estado, { error: 'slow down', code: 'rate_limit' });
      const error = await provider
        .send(cuentaDe(1), mensajeBase({ providerThreadId: 'hilo-1' }))
        .catch((e: unknown) => e);
      expect(esPermanente(error)).toBe(false);
      // Y sin reintento interno tampoco: una petición por intento de BullMQ.
      expect(peticiones).toHaveLength(1);
    }
  });
});

/** Un envío que ABRE conversación: sin hilo y con plantilla (ADR-0033, #44). */
const mensajeQueAbre = (): OutboundMessage =>
  mensajeBase({
    providerThreadId: undefined,
    extra: { plantilla: { name: 'cotizacion', language: 'es_CL', valores: ['Juan', '2'] } },
  });

describe('crear la conversación: la ruta sin llave hace ambiguo el fallo', () => {
  // La ruta de crear NO acepta `Idempotency-Key` (spec v1.527): un 5xx o una red
  // caída a mitad de la petición no dicen si la conversación —con su plantilla—
  // alcanzó a crearse. Reintentar sin saber manda la plantilla DOS veces al
  // cliente, así que lo ambiguo se clasifica permanente y le pide a una persona
  // que revise la conversación antes de reenviar. El 429 no: es un rechazo
  // ANTES de procesar, reintentarlo no puede duplicar nada.

  it('502 creando la conversación: permanente, con el mensaje de revisar, y UNA sola petición', async () => {
    const provider = createZernioProvider('whatsapp');
    interceptar(502, { error: 'Bad gateway', code: 'internal' });

    const error = await provider.send(cuentaDe(1), mensajeQueAbre()).catch((e: unknown) => e);

    // La ruta no acepta Idempotency-Key: un reintento mandaría la plantilla dos
    // veces. El adaptador tampoco reintenta por dentro.
    expect(peticiones).toHaveLength(1);
    expect(esPermanente(error)).toBe(true);
    expect((error as Error).message).toBe(
      'No sabemos si este mensaje alcanzó a salir. Revisa la conversación antes de volver a enviarlo.',
    );
  });

  it('fetch que rechaza creando la conversación: permanente con el mismo mensaje', async () => {
    // Mismo fundamento que el 5xx: la petición pudo llegar y perderse la
    // respuesta. Sin llave que deduplique, reintentar es arriesgar el duplicado.
    let llamadas = 0;
    const provider = createZernioProvider('whatsapp', {
      fetchImpl: (() => {
        llamadas += 1;
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });

    const error = await provider.send(cuentaDe(1), mensajeQueAbre()).catch((e: unknown) => e);

    expect(llamadas).toBe(1);
    expect(esPermanente(error)).toBe(true);
    expect((error as Error).message).toBe(
      'No sabemos si este mensaje alcanzó a salir. Revisa la conversación antes de volver a enviarlo.',
    );
  });

  it('429 creando la conversación: NO permanente, el rechazo es anterior al procesamiento', async () => {
    const provider = createZernioProvider('whatsapp');
    interceptar(429, { error: 'slow down', code: 'rate_limit' });

    const error = await provider.send(cuentaDe(1), mensajeQueAbre()).catch((e: unknown) => e);

    // BullMQ reintenta con backoff, y sin reintento interno tampoco.
    expect(esPermanente(error)).toBe(false);
    expect(peticiones).toHaveLength(1);
  });

  it('201 sin conversationId: sigue siendo permanente, `clasificar` no lo convierte en otra cosa', async () => {
    const provider = createZernioProvider('whatsapp');
    interceptar(201, { success: true, data: { messageId: 'wamid.SIN-HILO' } });

    const error = await provider.send(cuentaDe(1), mensajeQueAbre()).catch((e: unknown) => e);

    // El permanente se lanza DENTRO del try, y `clasificar` tiene que
    // devolverlo tal cual: tratarlo como error de red lo volvería reintento.
    expect(esPermanente(error)).toBe(true);
    expect((error as Error).message).toBe(
      'No sabemos si este mensaje alcanzó a salir. Revisa la conversación antes de volver a enviarlo.',
    );
  });
});

describe('mandar dentro del hilo: el 5xx y la red sí se reintentan', () => {
  it('502 en el hilo: NO permanente, la ruta lleva Idempotency-Key y Zernio deduplica', async () => {
    const provider = createZernioProvider('whatsapp');
    interceptar(502, { error: 'Bad gateway', code: 'internal' });

    const error = await provider
      .send(cuentaDe(1), mensajeBase({ providerThreadId: 'hilo-1' }))
      .catch((e: unknown) => e);

    expect(esPermanente(error)).toBe(false);
    expect(peticiones).toHaveLength(1);
  });

  it('error de red en el hilo: NO permanente, se relanza tal cual para que BullMQ reintente', async () => {
    // El reintento llega con la MISMA `Idempotency-Key` y Zernio deduplica del
    // otro lado: es la única ruta por la que un envío puede repetirse seguro.
    const provider = createZernioProvider('whatsapp', {
      fetchImpl: (() => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });

    const error = await provider
      .send(cuentaDe(1), mensajeBase({ providerThreadId: 'hilo-1' }))
      .catch((e: unknown) => e);

    expect(esPermanente(error)).toBe(false);
    expect((error as Error).message).toBe('fetch failed');
  });
});
