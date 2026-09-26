import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
 */
const EXCEPCIONES: Record<string, string> = {
  'packages/ui/src/react/ui/checkbox.tsx':
    'Es el Checkbox del sistema: envuelve el primitivo de Radix, que es quien pone el input.',
  'packages/ui/src/react/ui/select.tsx':
    'Es el Select del sistema; el `<select>` que aparece está en un comentario que explica qué se cambió.',
  'packages/ui/src/react/ui/switch.tsx':
    'Es el Switch del sistema: mismo caso que el Checkbox.',
  'packages/ui/src/react/ui/data-table.tsx':
    'El comentario de arriba del Checkbox nombra el nativo para decir por qué NO se usa.',
};

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
      const texto = readFileSync(archivo, 'utf8');
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

  it('la lista de excepciones no junta polvo', () => {
    const relativos = new Set(archivos.map((a) => a.slice(RAIZ.length + 1)));
    const sobrantes = Object.keys(EXCEPCIONES).filter((e) => !relativos.has(e));
    expect(sobrantes, `excepciones de archivos que ya no existen: ${sobrantes.join(', ')}`).toEqual([]);
  });
});
