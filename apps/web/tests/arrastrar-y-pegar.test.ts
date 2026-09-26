import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Arrastrar un archivo y pegar una captura (#561).
 *
 * El gesto salió del bloque `file-upload-04` de blocks.so, pero lo que se
 * comparte es el COMPORTAMIENTO y no el recuadro: la pantalla de conocimiento
 * necesita una caja punteada fija y la bandeja un aviso encima del chat. Un
 * componente que sirviera a las dos terminaría con un `modo` y dos ramas.
 *
 * Aviso sobre el alcance de estas pruebas: son de FUENTE, como el resto de las
 * del front, porque en este repo no hay todavía nada que renderice un
 * componente y le despache eventos. La lógica de `dragenter`/`dragleave` y la
 * de pegar NO están cubiertas por una prueba de comportamiento; va en su issue.
 */
const RAIZ = join(__dirname, '..');
const HOOK = readFileSync(
  join(RAIZ, '..', '..', 'packages', 'ui', 'src', 'react', 'use-arrastre.ts'),
  'utf8',
);
const CHAT = readFileSync(join(RAIZ, 'components', 'bandeja', 'chat.tsx'), 'utf8');
const PDF = readFileSync(join(RAIZ, 'components', 'conocimiento-pdf.tsx'), 'utf8');

const sinComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('el gesto vive en un solo lugar (#561)', () => {
  it('ni la bandeja ni el conocimiento traen su propio onDrop', () => {
    // Dos copias del mismo manejador se separan en el primer arreglo: es
    // exactamente el defecto que este issue viene a no repetir.
    for (const [nombre, fuente] of [['chat.tsx', CHAT], ['conocimiento-pdf.tsx', PDF]] as const) {
      const limpio = sinComentarios(fuente);
      expect(limpio, nombre).not.toMatch(/onDrop=\{/);
      expect(limpio, nombre).not.toMatch(/onDragOver=\{/);
      expect(limpio, nombre).not.toMatch(/dataTransfer/);
      // Las dos lo reciben del hook, esparciendo sus props.
      expect(limpio, nombre).toMatch(/\{\.\.\.arrastre\.props\}/);
    }
  });

  it('el hook cuenta las entradas en vez de mirar un booleano', () => {
    // `dragenter` de un hijo llega ANTES del `dragleave` del padre, así que con
    // un booleano el resaltado se apaga al pasar sobre cualquier cosa de
    // adentro y parpadea. Es el error clásico de este gesto.
    expect(HOOK).toMatch(/dentro\.current \+= 1/);
    expect(HOOK).toMatch(/dentro\.current -= 1/);
    expect(HOOK).toMatch(/if \(dentro\.current === 0\) setArrastrando\(false\)/);
  });

  it('pegar texto sigue siendo pegar texto', () => {
    // Romper Ctrl+V en un campo de mensajes sería un arreglo peor que el
    // problema: solo se intercepta si el portapapeles trae un archivo.
    const limpio = sinComentarios(HOOK);
    const i = limpio.indexOf('if (archivos.length === 0) return;');
    const j = limpio.indexOf('e.preventDefault()', i);
    expect(i).toBeGreaterThan(0);
    // El `return` va ANTES del preventDefault: al revés, pegar texto se comería.
    expect(j).toBeGreaterThan(i);
  });

  it('arrastrar texto seleccionado no cuenta como adjuntar', () => {
    expect(HOOK).toMatch(/types\)\.includes\('Files'\)/);
  });
});

describe('en la bandeja (#561)', () => {
  it('recibe el panel entero, no un recuadro chico', () => {
    // Apuntar a una caja obliga a mirar dónde se suelta, que es justo lo que el
    // gesto viene a evitar.
    expect(CHAT).toMatch(/relative flex min-h-0 flex-1 flex-col" \{\.\.\.arrastre\.props\}/);
  });

  it('el aviso de «suéltalo acá» no se come el drop', () => {
    // Un overlay que recibe eventos intercepta el `drop` del contenedor y el
    // archivo no llega nunca. Es el bug que se descubre recién al probarlo.
    const i = CHAT.indexOf('arrastre.arrastrando &&');
    const overlay = CHAT.slice(i, i + 600);
    expect(i).toBeGreaterThan(0);
    expect(overlay).toContain('pointer-events-none');
  });

  it('fuera de la ventana de 24 h no se acepta nada', () => {
    // Ahí solo salen plantillas: aceptar una foto que no va a salir es prometer
    // algo que el canal no permite.
    expect(CHAT).toMatch(/useArrastre\(\{ alRecibir: setArchivo, activo: enVentana \}\)/);
  });

  it('pegar está en el campo de texto', () => {
    expect(CHAT).toMatch(/onPaste=\{arrastre\.alPegar\}/);
  });

  it('el clip sigue existiendo: arrastrar no es el único camino', () => {
    // A 360 px arrastrar no existe, y con teclado tampoco.
    expect(CHAT).toMatch(/type="file"/);
    expect(CHAT).toContain('Adjuntar un archivo');
  });
});

describe('sin hex suelto ni tamaños arbitrarios en lo nuevo (#561)', () => {
  it('el aviso usa tokens y la escala de Pulso', () => {
    const i = CHAT.indexOf('arrastre.arrastrando &&');
    const overlay = CHAT.slice(i, i + 1200);
    // Sin comentarios antes de buscar hex: un «#548» en una nota parece un
    // color de tres dígitos, y una guarda que grita por su propia explicación
    // se apaga igual de rápido que una que no grita.
    const codigo = sinComentarios(overlay);
    expect(codigo).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(codigo).not.toMatch(/text-\[\d/);
    expect(codigo).toMatch(/border-action/);
    // El velo con `color-mix` sobre el token, no con `/85`: los colores de Pulso
    // no están por canales, así que el modificador de opacidad no emite nada y
    // el aviso queda sin fondo. Lo cazó la guarda de #548 al escribir esto.
    expect(codigo).toMatch(/color-mix\(in_srgb,var\(--bg\)/);
    expect(codigo).not.toMatch(/bg-bg\/\d/);
    // Y un radio de Pulso, no el `rounded-xl` del bloque original.
    expect(codigo).toMatch(/rounded-bloque/);
    expect(codigo).not.toMatch(/rounded-(?:xl|2xl|3xl|md|lg)/);
  });
});

describe('el hook va antes del return temprano (#561)', () => {
  it('useArrastre se llama sin condición, arriba del «elige una conversación»', () => {
    // Lo puse abajo y reventó el panel entero: al elegir la primera
    // conversación React pasaba de N a N+1 hooks. En blanco, sin mensajes ni
    // campo de texto. Lo cazó la suite E2E —dos minutos— y ninguna guarda de
    // fuente podía verlo.
    const hook = CHAT.indexOf('useArrastre({');
    const retornoTemprano = CHAT.indexOf('if (!detalle) {');
    expect(hook).toBeGreaterThan(0);
    expect(retornoTemprano).toBeGreaterThan(0);
    expect(hook).toBeLessThan(retornoTemprano);
  });

  it('la regla de lint que lo caza está encendida como error', () => {
    // Faltaba `eslint-plugin-react-hooks` en un repo con cincuenta
    // componentes. Es la guarda más barata que existe para esto y caza en el
    // editor lo que el E2E caza en dos minutos.
    const config = readFileSync(join(RAIZ, '..', '..', 'eslint.config.mjs'), 'utf8');
    expect(config).toMatch(/'react-hooks\/rules-of-hooks': 'error'/);
  });
});
