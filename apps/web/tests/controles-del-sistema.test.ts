import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * Los controles salen del sistema, no del navegador.
 *
 * `packages/ui` tiene `Select` y `Checkbox` sobre Radix, con los tokens de
 * Pulso, el foco de 2 px y el comportamiento de teclado resuelto. Y aun
 * así, el producto estaba partido por la mitad: **seis pantallas usaban el
 * `<select>` nativo y seis el tematizado** (#293). Nadie lo había decidido;
 * simplemente nadie lo impuso.
 *
 * Se nota poco y se nota siempre: el selector de negocio —lo primero de la
 * barra lateral— se veía como un desplegable del sistema operativo al lado
 * de controles que no. Un `<select>` nativo no se puede tematizar de verdad
 * en ningún navegador.
 *
 * Si alguna vez hace falta un nativo a propósito, va en `EXCEPCIONES` con
 * su motivo, como las demás listas de este repo.
 */
const RAIZ = join(__dirname, '..', '..', '..');

/**
 * Los tres árboles donde vive interfaz, y no solo `apps/web` (#537).
 *
 * Miraba únicamente la app de clientes, con la lista de excepciones VACÍA —o
 * sea, afirmando que no quedaba ningún control nativo en el producto— mientras
 * había cuatro: un `<select>` en el shell del panel de plataforma y tres
 * `<input type="checkbox">` en `data-table.tsx`, que es el propio sistema de
 * diseño. El nativo se pinta con los colores del sistema operativo: en modo
 * noche queda un desplegable blanco en una pantalla oscura.
 */
const ARBOLES = [
  join(RAIZ, 'apps', 'web', 'components'),
  join(RAIZ, 'apps', 'web', 'app'),
  join(RAIZ, 'apps', 'admin', 'components'),
  join(RAIZ, 'apps', 'admin', 'app'),
  join(RAIZ, 'packages', 'ui', 'src', 'react'),
];

/**
 * Los primitivos que IMPLEMENTAN el control: ahí el nativo es el control.
 *
 * Con su ruta completa y no por nombre de archivo: `select.tsx` en otra carpeta
 * no queda exento de rebote.
 *
 * **Está vacía, y eso es la mitad del valor (#823).** Tenía cuatro entradas y
 * ninguna hacía falta: el escáner leía el texto CRUDO, sin pasar por
 * `fuenteLimpia` —el helper de #569, que existe justamente porque «el que la
 * escribe de nuevo se olvida de usarla»—, así que los patrones que encontraba
 * vivían dentro de comentarios. Medido: con los comentarios quitados,
 * `checkbox.tsx`, `select.tsx`, `switch.tsx` y `data-table.tsx` tienen CERO
 * ocurrencias de los tres patrones. Dos de ellos tenían cero incluso en crudo,
 * así que su motivo escrito —«envuelve el primitivo de Radix, que es quien
 * pone el input»— no describía nada del archivo.
 *
 * Lo que eso costaba: cuatro archivos del propio sistema de diseño exentos EN
 * BLOQUE de los tres patrones prohibidos. Un `<select>` nativo agregado de
 * verdad a cualquiera de ellos pasaba verde, y en modo noche eso es un
 * desplegable blanco en pantalla oscura. Es el mismo defecto que este archivo
 * narra de #537 —«la guarda solo miraba apps/web, así que los tres de este
 * archivo sobrevivieron»— reintroducido por la puerta de las excepciones.
 */
const EXCEPCIONES: Record<string, string> = {};

const PROHIBIDOS: Array<{ patron: RegExp; que: string; usa: string }> = [
  { patron: /<select\b/g, que: '<select> nativo', usa: 'Select de @iaxti/ui/react' },
  { patron: /type="checkbox"/g, que: 'checkbox nativo', usa: 'Checkbox de @iaxti/ui/react' },
  { patron: /type="radio"/g, que: 'radio nativo', usa: 'un grupo de Button con aria-pressed, o RadioGroup si se trae' },
];

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) fuentes(ruta, acc);
    else if (entrada.endsWith('.tsx')) acc.push(ruta);
  }
  return acc;
}

describe('los controles salen del sistema de diseño', () => {
  const archivos = ARBOLES.flatMap((d) => fuentes(d));

  it('hay pantallas que mirar', () => {
    expect(archivos.length).toBeGreaterThan(30);
  });

  it('ningún control nativo donde el sistema ya tiene uno', () => {
    const encontrados: string[] = [];
    for (const archivo of archivos) {
      const relativo = archivo.slice(RAIZ.length + 1);
      if (relativo in EXCEPCIONES) continue;
      // LIMPIO, que es la regla de la casa (#569): un patrón dentro de un
      // comentario que explica por qué NO se usa el nativo no es un nativo.
      const texto = fuenteLimpia(readFileSync(archivo, 'utf8'));
      for (const { patron, que, usa } of PROHIBIDOS) {
        const n = (texto.match(patron) ?? []).length;
        if (n > 0) encontrados.push(`${relativo}: ${n} ${que} — usa ${usa}`);
      }
    }
    expect(
      encontrados,
      'Controles nativos en el producto:\n  ' +
        encontrados.join('\n  ') +
        '\nUn nativo no se tematiza de verdad en ningún navegador. Si hace falta\n' +
        'uno a propósito, va en EXCEPCIONES con su motivo.',
    ).toEqual([]);
  });

  it('la lista de excepciones no junta polvo: ni archivos que no existen ni exenciones que no hacen falta', () => {
    const relativos = new Set(archivos.map((a) => a.slice(RAIZ.length + 1)));
    const sobrantes = Object.keys(EXCEPCIONES).filter((e) => !relativos.has(e));
    expect(sobrantes, `excepciones de archivos que ya no existen: ${sobrantes.join(', ')}`).toEqual([]);

    // Y la mitad que faltaba: que la exención siga haciendo falta. Antes solo
    // se comprobaba que el archivo existiera, así que una exención que ya no
    // tapa nada se quedaba para siempre tapando TODO el archivo (#823).
    const deMas = Object.keys(EXCEPCIONES).filter((e) => {
      const texto = fuenteLimpia(readFileSync(join(RAIZ, e), 'utf8'));
      return !PROHIBIDOS.some(({ patron }) => patron.test(texto));
    });
    expect(
      deMas,
      'Estas exenciones ya no tapan ningún control nativo, así que lo único que hacen es ' +
        `dejar el archivo entero fuera del escáner: ${deMas.join(', ')}`,
    ).toEqual([]);
  });

  it('el escáner mira donde debe: encuentra los controles del sistema', () => {
    // Anti-vacuidad. La comprobación de arriba es solo-negativa: si el escáner
    // dejara de leer estos árboles, `encontrados` queda vacío y pasa sin
    // vigilar nada. Se busca el componente del SISTEMA, que es lo que sí tiene
    // que estar.
    const conSelect = archivos.filter((a) =>
      /<Select\b|<Checkbox\b|<Switch\b/.test(fuenteLimpia(readFileSync(a, 'utf8'))),
    );
    expect(
      conSelect.length,
      'el escáner no encuentra ni un control del sistema: está mirando el árbol equivocado',
    ).toBeGreaterThan(5);
  });
});
