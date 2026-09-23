import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Mandar un archivo desde la bandeja (#458).
 *
 * El camino entero existía sin puerta: la URL prefirmada de R2, el campo
 * `attachments` del mensaje y el del puerto de canales. Lo que faltaba era
 * el selector — y que el adaptador tradujera el adjunto, porque el campo
 * estaba y nadie lo miraba: un mensaje con foto salía sin la foto.
 */
const CHAT = readFileSync(join(__dirname, '..', 'components', 'bandeja', 'chat.tsx'), 'utf8');
const BANDEJA = readFileSync(join(__dirname, '..', 'components', 'bandeja', 'bandeja.tsx'), 'utf8');

describe('adjuntar al responder', () => {
  it('con archivo, el texto es opcional', () => {
    // Una foto sola es un mensaje completo; exigir un pie obliga a
    // escribir «mira» para poder mandarla.
    expect(CHAT).toMatch(/!texto\.trim\(\) && !archivo/);
  });

  it('el archivo elegido se ve y se puede quitar', () => {
    // Uno elegido por error y no visto sale igual.
    expect(CHAT).toMatch(/\{archivo && enVentana/);
    expect(CHAT).toContain('Quitar');
  });

  it('se sube ANTES de mandar el mensaje', () => {
    // Al revés quedaría un mensaje prometiendo un adjunto que no existe.
    const i = BANDEJA.indexOf('uploadUrl');
    const j = BANDEJA.indexOf("accion('/messages'");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(j);
  });

  it('si la subida falla, no se manda nada', () => {
    expect(BANDEJA).toMatch(/if \(!subida\.ok\) throw new Error/);
  });
});

/**
 * Abrir lo que mandó el cliente (#460).
 *
 * `GET /attachments/url` existía y los adjuntos se guardaban desde #42; la
 * bandeja no los mostraba. Un mensaje que era SOLO una foto se veía como
 * una burbuja vacía.
 */
describe('abrir un adjunto recibido', () => {
  it('cada adjunto del mensaje se puede abrir', () => {
    expect(CHAT).toContain('onAbrirAdjunto(a.key)');
    expect(CHAT).toMatch(/m\.attachments\.map/);
  });

  it('la pestaña se abre dentro del clic, no al volver la firma', () => {
    // Abrirla después del `await` la bloquea el navegador: ya no viene de
    // un gesto de la persona.
    const i = BANDEJA.indexOf("window.open('', '_blank'");
    const j = BANDEJA.indexOf('/attachments/url?key=');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(j);
  });

  it('la llave viaja escapada', () => {
    expect(BANDEJA).toContain('encodeURIComponent(key)');
  });

  it('si la firma falla, se cierra la pestaña en blanco', () => {
    expect(BANDEJA).toContain('ventana?.close()');
  });

  it('lo que no se alcanzó a guardar se dice, no se esconde', () => {
    // El inbound tolera que la descarga falle y la URL del proveedor ya
    // caducó: no hay nada que abrir, pero sí algo que decir.
    expect(CHAT).toContain('m.lostAttachments > 0');
    expect(CHAT).toContain('pídeselo de nuevo');
  });
});
