import { describe, expect, it } from 'vitest';
import { createZavuProvider, referralDe } from '../application/zavu';

/**
 * Dos cosas que el adaptador decía mal, y una que no decía.
 *
 * 1. **Un sticker salía como imagen.** `envioDeAdjunto` decidía el
 *    `messageType` con `tipo.startsWith('image/')`, así que un `image/webp`
 *    —que es justo el formato que WhatsApp NO acepta como imagen— salía como
 *    `image`. Y la contradicción estaba en casa: nuestra propia tabla
 *    (`channels/domain/adjuntos.ts`) declara la clase `sticker` con
 *    `tipos: ['image/webp']` y deja `imagen` en jpeg y png. O sea que ya
 *    sabíamos que un webp no es una imagen válida, y lo mandábamos igual como
 *    imagen. El archivo se subía a R2 —que se paga—, el proveedor lo rechazaba
 *    y al cliente no le llegaba nada.
 *
 * 2. **`message.unsupported` no existía para nosotros.** Zavu lo manda cuando
 *    el cliente escribe algo que su modelo no representa (una encuesta, un
 *    carrito, una ubicación en vivo). `normalize` lo descartaba, así que el
 *    mensaje no aparecía en la bandeja Y la ventana de 24 h no se renovaba:
 *    después no se le podía contestar libre aunque acabara de escribir.
 *
 * 3. Y la atribución click-to-WhatsApp llega UNA sola vez. Si ese primer
 *    mensaje era de los que no se representan, se perdía para siempre.
 */
const CUENTA = {
  id: 'cuenta-1',
  tenantId: 'tenant-1',
  kind: 'whatsapp' as const,
  name: 'Número',
  state: 'active' as const,
  credentialRef: 'LLAVE_STICKER_TEST',
  config: { senderId: 'snd_1' },
};

function capturar(kind: 'whatsapp' | 'instagram' = 'whatsapp') {
  const cuerpos: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    cuerpos.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ id: 'msg_1' }) } as unknown as Response;
  }) as unknown as typeof fetch;
  process.env.LLAVE_STICKER_TEST = 'zv_test';
  return { cuerpos, provider: createZavuProvider(kind, { fetchImpl }) };
}

describe('un sticker sale como sticker y no como imagen', () => {
  it('un webp va con messageType sticker', async () => {
    // `sticker` es un messageType propio de la API. Pedirlo por su nombre es
    // todo lo que faltaba para que el archivo llegue.
    const { cuerpos, provider } = capturar();
    await provider.send(CUENTA, {
      to: '+56999000001',
      type: 'imagen',
      attachments: [{ url: 'https://r2.example/carita.webp', contentType: 'image/webp' }],
    });
    expect(cuerpos[0].messageType).toBe('sticker');
    expect(cuerpos[0].content).toEqual({ mediaUrl: 'https://r2.example/carita.webp' });
  });

  it('el tipo con parámetros igual se reconoce', async () => {
    // Un `Content-Type` real suele venir con charset o comillas colgando.
    const { cuerpos, provider } = capturar();
    await provider.send(CUENTA, {
      to: '+56999000001',
      type: 'imagen',
      attachments: [{ url: 'https://r2.example/x.webp', contentType: 'IMAGE/WEBP; charset=binary' }],
    });
    expect(cuerpos[0].messageType).toBe('sticker');
  });

  it('en Instagram y Messenger vale la misma tabla', async () => {
    // La clase del archivo no cambia con el canal; lo que cambia son los pesos.
    const { cuerpos, provider } = capturar('instagram');
    await provider.send(CUENTA, {
      to: 'US.13491208655302741918',
      type: 'imagen',
      attachments: [{ url: 'https://r2.example/x.webp', contentType: 'image/webp' }],
    });
    expect(cuerpos[0].messageType).toBe('sticker');
  });

  it('lo que la tabla SÍ acepta como imagen sigue saliendo como imagen', async () => {
    const { cuerpos, provider } = capturar();
    for (const tipo of ['image/jpeg', 'image/png']) {
      await provider.send(CUENTA, {
        to: '+56999000001',
        type: 'imagen',
        attachments: [{ url: `https://r2.example/x`, contentType: tipo }],
      });
    }
    expect(cuerpos.map((c) => c.messageType)).toEqual(['image', 'image']);
  });

  it('video, audio y documento no se movieron', async () => {
    const { cuerpos, provider } = capturar();
    for (const tipo of ['video/mp4', 'audio/ogg', 'application/pdf']) {
      await provider.send(CUENTA, {
        to: '+56999000001',
        type: 'documento',
        attachments: [{ url: 'https://r2.example/x', contentType: tipo }],
      });
    }
    expect(cuerpos.map((c) => c.messageType)).toEqual(['video', 'audio', 'document']);
  });

  it('un tipo que la tabla no conoce cae a documento y sale igual', async () => {
    // No debería llegar acá (revisarAdjunto corta antes de firmar la subida),
    // pero si llega, el cliente recibe el archivo en vez de nada.
    const { cuerpos, provider } = capturar();
    await provider.send(CUENTA, {
      to: '+56999000001',
      type: 'documento',
      attachments: [{ url: 'https://r2.example/x.zip', filename: 'planos.zip', contentType: 'application/zip' }],
    });
    expect(cuerpos[0].messageType).toBe('document');
    expect(cuerpos[0].content).toEqual({
      mediaUrl: 'https://r2.example/x.zip',
      filename: 'planos.zip',
    });
  });
});

describe('un mensaje que no se puede representar sigue siendo un mensaje', () => {
  const provider = createZavuProvider('whatsapp', { apiBase: 'https://zavu.test/v1' });

  const noSoportado = (data: Record<string, unknown> = {}) => ({
    id: 'evt_1',
    type: 'message.unsupported',
    timestamp: 1_700_000_000_000,
    senderId: 'snd_1',
    data: {
      messageId: 'msg-encuesta',
      from: '+56987654321',
      to: '+56922013949',
      channel: 'whatsapp',
      messageType: 'poll',
      providerTimestamp: 1_700_000_000_000,
      ...data,
    },
  });

  it('entra a la bandeja, con el id del proveedor y su hora', () => {
    // Antes esto devolvía [] y el cliente había escrito igual: para quien
    // atiende, no pasó nada. Y la ventana de 24 h se quedaba sin renovar,
    // porque lo que la mueve es que exista el mensaje entrante.
    const mensajes = provider.normalize(noSoportado());
    expect(mensajes).toHaveLength(1);
    expect(mensajes[0]).toMatchObject({
      phone: '+56987654321',
      type: 'texto',
      providerMessageId: 'msg-encuesta',
      timestamp: '1700000000',
    });
  });

  it('dice qué pasó y qué hacer, en vez de quedar en blanco', () => {
    const [mensaje] = provider.normalize(noSoportado());
    expect(mensaje.body).toMatch(/no podemos mostrar/i);
    expect(mensaje.body).toMatch(/Ábrelo en WhatsApp/);
  });

  it('si el proveedor alcanzó a sacar texto, ese manda: es lo que escribió', () => {
    const [mensaje] = provider.normalize(noSoportado({ text: '¿Cuál prefieres?' }));
    expect(mensaje.body).toBe('¿Cuál prefieres?');
  });

  it('sigue exigiendo id y remitente, como cualquier entrante', () => {
    expect(provider.normalize(noSoportado({ messageId: undefined }))).toHaveLength(0);
    expect(provider.normalize(noSoportado({ from: undefined }))).toHaveLength(0);
  });

  it('los eventos de salida siguen sin producir mensajes', () => {
    // La verdad la dice el TIPO del evento, y abrir la puerta a un entrante
    // más no la abre para los estados de entrega.
    expect(provider.normalize({ type: 'message.delivered', data: { messageId: 'x', from: '+569' } })).toHaveLength(0);
    expect(provider.normalize({ type: 'message.queued', data: { messageId: 'x', from: '+569' } })).toHaveLength(0);
  });

  it('la atribución del aviso no se pierde por llegar en uno de estos', () => {
    // Llega SOLO en el primer mensaje del hilo y no hay segunda entrega.
    const referral = { sourceType: 'ad', ctwaClid: 'ARIzZm9vYmFy' };
    expect(referralDe(noSoportado({ referral }))).toEqual(referral);
  });
});
