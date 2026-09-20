import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cada hoja de estilo que el paquete publica la importa alguna app.
 *
 * `shadcn-puente.css` se escribió en #291 —el archivo que ata los nombres
 * de shadcn a los tokens de Pulso— y **nunca se enchufó**: no estaba en los
 * `exports` del package.json ni lo importaba ningún layout. O sea que desde
 * entonces cada componente traído del registro usaba variables SIN DEFINIR
 * (`--background`, `--popover`, `--accent`) y pintaba con lo que heredara.
 *
 * No falla nada visible de golpe, que es lo que lo hizo durar: se ve como
 * "la interfaz está un poco sosa". Apareció al traer la barra lateral
 * (#295), cuyo estado activo simplemente no se veía porque
 * `--sidebar-accent` no existía en el CSS compilado.
 *
 * Este test vive acá y no en las apps a propósito: lo que dispara el
 * problema es agregar una hoja NUEVA a este paquete, y así el cambio que lo
 * causa es el que invalida la caché del test que lo caza.
 */
const UI = join(__dirname, '..');
const RAIZ = join(UI, '..', '..');
const LAYOUTS = ['apps/web/app/layout.tsx', 'apps/admin/app/layout.tsx'];

const pkg = JSON.parse(readFileSync(join(UI, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>;
  name: string;
};

const hojas = Object.keys(pkg.exports).filter((k) => k.endsWith('.css'));

describe('las hojas de estilo llegan a las apps', () => {
  it('hay hojas exportadas que mirar', () => {
    expect(hojas.length).toBeGreaterThanOrEqual(2);
  });

  for (const layout of LAYOUTS) {
    it(`${layout} las importa todas`, () => {
      const texto = readFileSync(join(RAIZ, layout), 'utf8');
      const faltan = hojas.filter((h) => !texto.includes(`${pkg.name}${h.slice(1)}`));
      expect(
        faltan,
        `Estas hojas se publican y no las importa ${layout}:\n` +
          faltan.map((h) => `  ${pkg.name}${h.slice(1)}`).join('\n') +
          '\nUna variable sin definir no rompe nada: hereda, y la interfaz queda sosa.',
      ).toEqual([]);
    });
  }

  it('toda variable que el preset mapea está definida en alguna hoja', () => {
    // El preset dice `background: 'var(--background)'`. Si nadie define
    // `--background`, la clase existe, compila, y no pinta nada.
    //
    // Lee TODAS las hojas exportadas y no una lista a mano. La primera
    // versión miraba solo el puente y los tokens, y se puso roja contra
    // `--fila-x` de #354, que vive en `pulso-base.css`: la variable estaba
    // definida y el test no sabía dónde mirar. Un test que hay que editar
    // cada vez que aparece una hoja es el mismo problema que este archivo
    // existe para cazar.
    const preset = readFileSync(join(UI, 'tailwind-preset.cjs'), 'utf8');
    const css = hojas.map((h) => readFileSync(join(UI, h.slice(2)), 'utf8')).join('\n');
    const usadas = [...preset.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
    const definidas = new Set(
      [...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]),
    );
    const sinDefinir = [...new Set(usadas)].filter((v) => !definidas.has(v));
    expect(
      sinDefinir,
      `El preset mapea estas variables y ninguna hoja exportada las define:\n  ${sinDefinir.join('\n  ')}\n` +
        `Hojas miradas: ${hojas.join(', ')}.`,
    ).toEqual([]);
  });
});
