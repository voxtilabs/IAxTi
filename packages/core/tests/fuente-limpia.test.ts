import { describe, expect, it } from 'vitest';
import { fuenteLimpia } from '../src/testing/fuente-limpia';

/**
 * Las dos trampas que todas las copias tenían, y la que nadie había notado
 * (#569).
 *
 * El issue nombra dos: que hay que quitar los comentarios de JSX, y que NO hay
 * que quitar un `//` que viva dentro de un string —hoy todas las copias parten
 * al medio cualquier `https://…`—. La tercera la encontré al escribir esto: las
 * copias **filtraban líneas**, así que todo lo de abajo se corría de lugar y
 * cualquier guarda que reportara «línea 42» mentía. Acá el comentario se cambia
 * por espacios y la numeración se conserva.
 */
describe('fuenteLimpia (#569)', () => {
  it('quita comentarios de línea, de bloque y de JSX', () => {
    const limpio = fuenteLimpia(`const a = 1; // nota
/* bloque
   de dos líneas */
const b = 2;
{/* un comentario de JSX */}
const c = 3;`);
    expect(limpio).not.toContain('nota');
    expect(limpio).not.toContain('bloque');
    expect(limpio).not.toContain('JSX');
    expect(limpio).toContain('const a = 1;');
    expect(limpio).toContain('const b = 2;');
    expect(limpio).toContain('const c = 3;');
  });

  it('las llaves del comentario de JSX se van con él', () => {
    // Dejarlas convierte `{/* nota */}` en `{}`, y hay guardas que cuentan
    // llaves para encontrar dónde termina una llamada.
    const limpio = fuenteLimpia('<div>{/* nota */}</div>');
    expect(limpio).not.toContain('{');
    expect(limpio).not.toContain('}');
    // Y en el lugar del comentario quedan espacios, no un hueco: el largo del
    // archivo no cambia, que es lo que mantiene las columnas en su lugar.
    expect(limpio).toHaveLength('<div>{/* nota */}</div>'.length);
    expect(limpio.replace(/ /g, '')).toBe('<div></div>');
  });

  it('NO toca un `//` dentro de un string: una URL sobrevive', () => {
    // La trampa que el issue nombra, y la que hace desconfiar de la herramienta
    // en el peor momento.
    for (const fuente of [
      `const u = 'https://api.zavu.cl/v1/senders';`,
      `const u = "https://api.zavu.cl/v1/senders";`,
      'const u = `https://api.zavu.cl/v1/senders`;',
    ]) {
      expect(fuenteLimpia(fuente), fuente).toContain('https://api.zavu.cl/v1/senders');
    }
  });

  it('NO toca un `/*` ni un `*/` dentro de un string', () => {
    expect(fuenteLimpia(`const s = 'esto /* no */ es comentario';`)).toContain(
      'esto /* no */ es comentario',
    );
  });

  it('NO destruye una expresión regular que contiene barras', () => {
    // `/\/\//` es una regex que busca `//`. Una copia ingenua la lee como el
    // comienzo de un comentario y se come el resto de la línea — y este
    // repositorio está lleno de guardas que son exactamente eso.
    const fuente = String.raw`const re = /\/\//g; const otra = 1;`;
    const limpio = fuenteLimpia(fuente);
    expect(limpio).toContain(String.raw`/\/\//g`);
    expect(limpio).toContain('const otra = 1;');
  });

  it('conserva la numeración de líneas', () => {
    // Lo que las copias rompían: filtraban las líneas de comentario y todo lo
    // de abajo se corría. Una guarda que reporta «línea 42» tiene que apuntar a
    // la línea 42 del archivo de verdad.
    const fuente = ['// uno', '/* dos', '   tres */', 'const cuatro = 4;', '// cinco'].join('\n');
    const limpio = fuenteLimpia(fuente);
    expect(limpio.split('\n')).toHaveLength(5);
    expect(limpio.split('\n')[3]).toContain('const cuatro = 4;');
  });

  it('una comilla suelta en prosa no se come el resto del archivo', () => {
    // El apóstrofo del español, que está en medio archivo de este repo. Si el
    // comentario se quita ANTES, no hay comilla; pero si quedara abierta, todo
    // lo de abajo se leería como string y la guarda no vería nada.
    const limpio = fuenteLimpia(`// no se qu' pasa aquí
const importante = 'si';`);
    expect(limpio).toContain(`const importante = 'si';`);
  });

  it('un comentario sin cerrar no rompe: se lleva lo que queda y nada más', () => {
    const limpio = fuenteLimpia('const a = 1;\n/* abierto y nunca cerrado\nconst b = 2;');
    expect(limpio).toContain('const a = 1;');
    expect(limpio).not.toContain('const b = 2;');
    // Y las líneas siguen siendo tres: lo borrado son espacios, no líneas.
    expect(limpio.split('\n')).toHaveLength(3);
  });

  it('el texto sin comentarios vuelve igual', () => {
    const fuente = 'export const x = 1;\nexport const y = x / 2;\n';
    expect(fuenteLimpia(fuente)).toBe(fuente);
  });
});
