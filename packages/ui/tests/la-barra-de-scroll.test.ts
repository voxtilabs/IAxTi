import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * La barra de scroll en Pulso (#601).
 *
 * No la tocábamos, así que el navegador ponía la del sistema operativo: en modo
 * noche, una barra gris clara sobre un panel oscuro. Era la única pieza de la
 * interfaz que no sabía en qué modo estaba — y se ve mucho acá, porque la bandeja
 * tiene tres paneles con scroll y las tablas scrollean en horizontal.
 *
 * Estas guardas existen sobre todo por UNA de las decisiones: que no se esconda.
 * Es la que alguien va a querer deshacer dentro de seis meses para que una captura
 * se vea más limpia, y por eso el motivo va escrito acá y no solo en el CSS.
 */
const CSS = readFileSync(join(__dirname, '..', 'pulso-base.css'), 'utf8');

const sinComentarios = (f: string) => f.replace(/\/\*[\s\S]*?\*\//g, '');

describe('la barra de scroll sigue los tokens (#601)', () => {
  it('el color sale de tokens, nunca de un hex', () => {
    const scroll = sinComentarios(CSS).slice(sinComentarios(CSS).indexOf('scrollbar-width'));
    expect(scroll).toMatch(/scrollbar-color:\s*var\(--/);
    expect(scroll).toMatch(/::-webkit-scrollbar-thumb[\s\S]*?background:\s*var\(--/);
    // Un hex acá sería una barra que no cambia de día a noche, que es el bug que
    // este cambio viene a arreglar.
    expect(scroll).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('cubre el estándar Y Safari, con los mismos tokens', () => {
    // `scrollbar-color` lo entienden Firefox y Chrome 121+; Safari todavía no, y
    // necesita los pseudo-elementos. Si solo estuviera uno, media base de usuarios
    // seguiría viendo la barra del sistema.
    expect(CSS).toMatch(/scrollbar-color:/);
    expect(CSS).toMatch(/::-webkit-scrollbar-thumb/);
  });
});

describe('lo que NO se hizo, y es a propósito (#601)', () => {
  it('la barra no se esconde', () => {
    // La tentación de `width: 0` o de una barra de 4 px que aparece al pasar el
    // mouse queda linda en una captura. Pero la barra es lo ÚNICO que dice que hay
    // más contenido abajo, y para alguien con dificultad motora una de 4 px es
    // imposible de agarrar.
    const scroll = sinComentarios(CSS);
    expect(scroll).not.toMatch(/::-webkit-scrollbar\s*\{[^}]*width:\s*0/);
    expect(scroll).not.toMatch(/scrollbar-width:\s*none/);
    const ancho = scroll.match(/::-webkit-scrollbar\s*\{[^}]*width:\s*(\d+)px/);
    expect(ancho, 'el ancho tiene que estar declarado').toBeTruthy();
    expect(Number(ancho![1]), 'menos de 8 px no se puede agarrar').toBeGreaterThanOrEqual(8);
  });

  it('el pulgar se adelgaza con borde transparente, sin perder área de click', () => {
    // Es el truco que permite que se DIBUJE de 6 px y se AGARRE de 10: el borde
    // transparente recorta el fondo sin recortar el elemento.
    const scroll = sinComentarios(CSS);
    expect(scroll).toMatch(/border:\s*2px solid transparent/);
    expect(scroll).toMatch(/background-clip:\s*padding-box/);
  });

  it('no se anima', () => {
    // Pulso no tiene animación continua, y una barra que crece al acercarse el
    // puntero es justo eso. El cambio de color en hover se nota igual y no se mueve.
    const i = sinComentarios(CSS).indexOf('scrollbar-width');
    const scroll = sinComentarios(CSS).slice(i);
    expect(scroll).not.toMatch(/transition|animation|@keyframes/);
    // Y sí hay hover, porque sin ninguna señal el pulgar parece decorativo.
    expect(scroll).toMatch(/::-webkit-scrollbar-thumb:hover/);
  });

  it('el riel es transparente y no un color de superficie', () => {
    // Así sirve igual sobre `bg`, `raised` y `rest` sin una regla por superficie —
    // y sin una regla por superficie no hay una que se olvide.
    expect(sinComentarios(CSS)).toMatch(/::-webkit-scrollbar-track\s*\{[^}]*background:\s*transparent/);
  });

  it('reserva el espacio para que la página no salte', () => {
    // Sin esto, cuando el contenido pasa a ser scrolleable el layout se corre ~10 px.
    // Es chico y es exactamente lo que se siente como «no terminado» (#588).
    expect(sinComentarios(CSS)).toMatch(/scrollbar-gutter:\s*stable/);
  });
});
