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
