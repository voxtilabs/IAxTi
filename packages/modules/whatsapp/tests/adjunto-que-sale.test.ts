import { describe, expect, it } from 'vitest';
import { createZavuProvider } from '../application/zavu';

/**
 * Un adjunto que de verdad sale (#458).
 *
 * El campo `attachments` existía en el puerto desde el principio y el
 * adaptador NO lo miraba: su `send` armaba el cuerpo con `text` y con
 * plantillas, nada más. Un mensaje con foto salía sin la foto — y la
 * entrada de archivos sí estaba completa desde #42, así que el producto
 * recibía imágenes y no podía mandar ninguna.
 */
const CUENTA = {
  id: 'cuenta-1',
  tenantId: 'tenant-1',
  kind: 'whatsapp' as const,
  name: 'Número',
  state: 'active' as const,
  credentialRef: 'LLAVE_ADJUNTOS_TEST',
  config: { senderId: 'snd_1' },
};

function capturar() {
  const cuerpos: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    cuerpos.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ id: 'msg_1' }) } as unknown as Response;
  }) as unknown as typeof fetch;
  process.env.LLAVE_ADJUNTOS_TEST = 'zv_test';
  return { cuerpos, provider: createZavuProvider('whatsapp', { fetchImpl }) };
}

describe('mandar un archivo', () => {
  it('una imagen va como imagen, y el texto pasa a ser el pie de foto', async () => {
    const { cuerpos, provider } = capturar();
    await provider.send(CUENTA, {
      to: '+56999000001',
      type: 'imagen',
      body: 'Acá va la cotización',
      attachments: [{ url: 'https://r2.example/firmada.jpg', contentType: 'image/jpeg' }],
    });
    expect(cuerpos[0].messageType).toBe('image');
    expect(cuerpos[0].content).toEqual({ mediaUrl: 'https://r2.example/firmada.jpg' });
    expect(cuerpos[0].text).toBe('Acá va la cotización');
  });

  it('un PDF va como documento y CON su nombre', async () => {
    // En un documento el nombre es lo que el cliente ve; en una imagen lo
    // que se ve es el pie, y mandar el nombre ahí no aporta nada.
    const { cuerpos, provider } = capturar();
    await provider.send(CUENTA, {
      to: '+56999000001',
      type: 'documento',
      attachments: [
        { url: 'https://r2.example/x.pdf', filename: 'cotizacion.pdf', contentType: 'application/pdf' },
      ],
    });
    expect(cuerpos[0].messageType).toBe('document');
    expect(cuerpos[0].content).toEqual({
      mediaUrl: 'https://r2.example/x.pdf',
      filename: 'cotizacion.pdf',
    });
  });

  it('el tipo sale del CONTENIDO, no de la extensión del nombre', async () => {
    // Un `.jpg` renombrado a `.pdf` se manda como imagen igual: lo que el
    // proveedor mira es el tipo del archivo.
    const { cuerpos, provider } = capturar();
    await provider.send(CUENTA, {
      to: '+56999000001',
      type: 'imagen',
      attachments: [{ url: 'https://r2.example/x.pdf', filename: 'foto.pdf', contentType: 'image/png' }],
    });
    expect(cuerpos[0].messageType).toBe('image');
  });

  it('solo sale el primero: WhatsApp manda un medio por mensaje', async () => {
    // Pasar el segundo en silencio sería prometer que salió.
    const { cuerpos, provider } = capturar();
    await provider.send(CUENTA, {
      to: '+56999000001',
      type: 'imagen',
      attachments: [
        { url: 'https://r2.example/1.jpg', contentType: 'image/jpeg' },
        { url: 'https://r2.example/2.jpg', contentType: 'image/jpeg' },
      ],
    });
    expect((cuerpos[0].content as { mediaUrl: string }).mediaUrl).toBe('https://r2.example/1.jpg');
  });

  it('sin adjuntos el cuerpo no cambia en nada', async () => {
    const { cuerpos, provider } = capturar();
    await provider.send(CUENTA, { to: '+56999000001', type: 'texto', body: 'hola' });
    expect(cuerpos[0].messageType).toBeUndefined();
    expect(cuerpos[0].content).toBeUndefined();
    expect(cuerpos[0].text).toBe('hola');
  });
});
