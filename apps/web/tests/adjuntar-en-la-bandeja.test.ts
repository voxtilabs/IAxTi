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
    expect(CHAT).toMatch(/\(m\.attachments \?\? \[\]\)\.map/);
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
    expect(CHAT).toContain('(m.lostAttachments ?? 0) > 0');
    expect(CHAT).toContain('pídeselo de nuevo');
  });
});

/**
 * Los límites, y que el aviso llegue a la pantalla (#560).
 *
 * La revisión del servidor no sirve de nada si su mensaje muere en el camino, y
 * era justo lo que pasaba: el error del adjunto se escapaba de `onResponder` y
 * de `enviar`, que tampoco tenía catch. Quedaba una promesa rechazada sin dueño,
 * el clip puesto y NINGÚN aviso en pantalla.
 */
describe('qué se puede adjuntar, y qué se ve cuando no (#560)', () => {
  it('la interfaz no tiene su propia copia de los tipos ni de los tamaños', () => {
    // Dos tablas —una en la API y otra acá— se separan en el primer cambio, y
    // entonces el clip ofrece subir lo que la ruta va a rechazar.
    //
    // Esta guarda es PREVENTIVA y conviene decirlo: contra el código de antes
    // pasaba igual, porque antes no había ninguna tabla en ninguna parte. Las
    // otras cuatro de este bloque sí fallan contra el código anterior.
    const sinComentarios = (f: string) =>
      f.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    for (const [nombre, fuente] of [['chat.tsx', CHAT], ['bandeja.tsx', BANDEJA]] as const) {
      const limpio = sinComentarios(fuente);
      // Ni tipos MIME de archivo escritos a mano, con UNA excepción escrita:
      // `application/octet-stream` no es parte de la tabla, es lo que se manda
      // cuando el navegador no supo qué archivo es. Y está bien que la ruta lo
      // rechace: un tipo desconocido no se puede mandar por WhatsApp.
      const conTipos = [...limpio.matchAll(/['"](?:image|video|audio|application)\/[a-z0-9.+-]+['"]/g)]
        .map((m) => m[0].slice(1, -1))
        .filter((t) => t !== 'application/octet-stream');
      expect(conTipos, nombre).toEqual([]);
      // …ni topes en MB.
      expect(limpio, nombre).not.toMatch(/\d+\s*\*\s*1024\s*\*\s*1024/);
    }
  });

  it('el `accept` del selector sale de la tabla que sirve la API', () => {
    expect(CHAT).toMatch(/limitesDeAdjunto\?\.limites\.flatMap/);
    expect(CHAT).toMatch(/accept: aceptados/);
    expect(BANDEJA).toContain('/attachments/limites');
  });

  it('el tipo y el peso se mandan al pedir la URL: sin eso no hay revisión', () => {
    expect(BANDEJA).toMatch(/contentType,/);
    expect(BANDEJA).toMatch(/sizeBytes: archivo\.size/);
  });

  it('un adjunto rechazado muestra el aviso en vez de perderse en silencio', () => {
    // El catch tiene que estar alrededor de la subida, no solo del envío.
    const i = BANDEJA.indexOf("/attachments`");
    const j = BANDEJA.indexOf('setAviso((err as Error).message);\n                return false;');
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
  });

  it('un envío que falló NO borra lo que se escribió', () => {
    // Perder el borrador porque WhatsApp cerró la ventana obliga a redactarlo
    // de nuevo, y eso pasa a diario.
    expect(CHAT).toMatch(/if \(await onResponder\(/);
    expect(CHAT).toMatch(/onResponder: \(texto: string, adjunto\?: File\) => Promise<boolean>/);
    // Y `accion` tiene que informar si salió: si devolviera void, el de arriba
    // sería siempre verdadero y estaríamos como antes.
    expect(BANDEJA).toMatch(/async function accion\([^)]*\): Promise<boolean>/);
    expect(BANDEJA).toMatch(/return true;/);
  });
});
