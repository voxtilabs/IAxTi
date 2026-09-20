import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cn } from '../src/react/ui/cn';

describe('escala tipográfica Pulso (#297)', () => {
  it('el merge distingue tamaños semánticos de colores y reemplaza tamaños anteriores', () => {
    for (const tamano of ['titulo', 'seccion', 'cuerpo', 'dato', 'rotulo']) {
      const clases = cn('text-sm text-muted', `text-${tamano} text-ink`).split(' ');
      expect(clases).toContain(`text-${tamano}`);
      expect(clases).toContain('text-ink');
      expect(clases).not.toContain('text-sm');
      expect(clases).not.toContain('text-muted');
    }
  });

  it('los componentes no introducen tamaños tipográficos arbitrarios', () => {
    const raiz = resolve(__dirname, '../../..');
    const fallos: string[] = [];
    function revisar(dir: string) {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.next', '.turbo'].includes(entrada.name)) continue;
        const ruta = join(dir, entrada.name);
        if (entrada.isDirectory()) revisar(ruta);
        else if (ruta.endsWith('.tsx') && /text-\[\d+(?:\.\d+)?(?:px|rem|em)\]/.test(readFileSync(ruta, 'utf8'))) {
          fallos.push(ruta.slice(raiz.length + 1));
        }
      }
    }
    for (const carpeta of ['apps/web', 'apps/admin', 'packages/ui/src']) revisar(join(raiz, carpeta));
    expect(fallos, 'Usa la escala de packages/ui/tailwind-preset.cjs.').toEqual([]);
  });
});
