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

/**
 * El agujero del comentario JSX (encontrado armando #761).
 *
 * La regla que reconocía `{/* nota *\/}` aceptaba saltos de línea entre la
 * llave y el comentario, y su cuerpo se estiraba hasta encontrar un `*\/`
 * seguido de `}`. Con eso, un `try {` documentado —la forma más común de
 * escribir esto en el repo— se comía todo el código hasta un `*\/}` lejano.
 *
 * Y el modo de falla es el peor posible: la guarda recibe un archivo medio
 * vacío y **toda aserción negativa pasa sola**. Tres pruebas de #690 se
 * pusieron verdes sin comprobar nada; lo que las delató fue una POSITIVA.
 */
describe('un comentario de bloque dentro de llaves no es un comentario JSX', () => {
  it('no se come el código que viene después', () => {
    const fuente = [
      'try {',
      '  /** Una nota que explica lo de abajo. */',
      '  const importante = 1;',
      '} catch (e) {',
      '  /* otra nota */',
      '  const tambien = 2;',
      '}',
    ].join('\n');
    const limpio = fuenteLimpia(fuente);
    expect(limpio).toContain('const importante = 1;');
    expect(limpio).toContain('const tambien = 2;');
    // Las llaves del código siguen ahí: hay guardas que las cuentan.
    expect(limpio).toContain('try {');
    expect(limpio).toContain('} catch (e) {');
  });

  it('el comentario JSX de verdad sigue saliendo completo, con sus llaves', () => {
    // Se comprueban las PROPIEDADES y no la cadena exacta: contar los espacios
    // a mano es contar los caracteres del comentario, y esa aserción falla por
    // una coma de más en la prosa de la prueba. (Me pasó: puse 14 donde iban 12.)
    const fuente = '<p>{/* nota */}texto</p>';
    const limpio = fuenteLimpia(fuente);
    expect(limpio).toHaveLength(fuente.length); // la numeración se conserva
    expect(limpio).not.toContain('{'); // las llaves se van con el comentario
    expect(limpio).not.toContain('nota');
    expect(limpio).toContain('<p>');
    expect(limpio).toContain('texto</p>');
  });

  it('y el JSX multilínea también, mientras el `/*` vaya pegado a la llave', () => {
    const limpio = fuenteLimpia('<p>{/* una\n   nota larga */}fin</p>');
    expect(limpio).not.toContain('nota larga');
    expect(limpio).not.toContain('{');
    expect(limpio).toContain('fin');
    // La numeración de líneas se conserva: el salto sigue ahí.
    expect(limpio.split('\n')).toHaveLength(2);
  });
});
