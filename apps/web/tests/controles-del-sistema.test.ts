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
const COMPONENTES = join(__dirname, '..', 'components');
const APP = join(__dirname, '..', 'app');

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
  const archivos = [...fuentes(COMPONENTES), ...fuentes(APP)];

  it('hay pantallas que mirar', () => {
    expect(archivos.length).toBeGreaterThan(30);
  });

  it('ningún control nativo donde el sistema ya tiene uno', () => {
    const encontrados: string[] = [];
    for (const archivo of archivos) {
      const nombre = archivo.split('/').pop()!;
      if (nombre in EXCEPCIONES) continue;
      const texto = readFileSync(archivo, 'utf8');
      for (const { patron, que, usa } of PROHIBIDOS) {
        const n = (texto.match(patron) ?? []).length;
        if (n > 0) encontrados.push(`${nombre}: ${n} ${que} — usa ${usa}`);
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
    const nombres = new Set(archivos.map((a) => a.split('/').pop()!));
    const sobrantes = Object.keys(EXCEPCIONES).filter((e) => !nombres.has(e));
    expect(sobrantes, `excepciones de archivos que ya no existen: ${sobrantes.join(', ')}`).toEqual([]);
  });
});
