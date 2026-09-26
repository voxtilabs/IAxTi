import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { cn } from '../src/react/ui/cn';

/** `{sidebar:{accent:{foreground}}}` → `sidebar-accent-foreground`. */
function aplanarColores(valor: unknown, prefijo = ''): string[] {
  if (!valor || typeof valor !== 'object') return prefijo ? [prefijo] : [];
  return Object.entries(valor as Record<string, unknown>).flatMap(([k, v]) => {
    const nombre = k === 'DEFAULT' ? prefijo : prefijo ? `${prefijo}-${k}` : k;
    return typeof v === 'object' && v !== null ? aplanarColores(v, nombre) : [nombre];
  });
}

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

  it('ninguna clase `text-` inventada: Tailwind no la genera y no falla nada', () => {
    // `text-micro` se usaba en 20 lugares de 9 componentes y no estaba
    // definida en ninguna parte — ni en el preset ni en un CSS. Tailwind
    // simplemente no emite nada para una clase que no conoce, así que esos
    // 20 textos se veían del tamaño que heredaban. Nadie lo notó porque no
    // hay error: el build pasa, el lint pasa, y el producto se ve mal en
    // sitios chicos. Comprobado con `npx tailwindcss`: emite `.text-dato` y
    // para `text-micro` no emite una sola línea.
    //
    // Mismo patrón de siempre acá: usado en un lado, declarado en ninguno.
    // Del preset de verdad y no de una lista copiada: una copia envejece y
    // entonces la guarda marca como inventada una clase que sí existe, o al
    // revés. `createRequire` porque el preset es CommonJS.
    const preset = createRequire(import.meta.url)('../tailwind-preset.cjs') as {
      theme: { extend: { fontSize: Record<string, unknown>; colors: Record<string, unknown> } };
    };
    const extend = preset.theme.extend;

    /** Lo que `text-X` puede ser: un tamaño, un color, o alineación. */
    const permitidas = new Set<string>([
      // Tamaños de Tailwind que seguimos usando en código heredado.
      'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl',
      // Los de la escala Pulso.
      ...Object.keys(extend.fontSize),
      // Colores: los nuestros y los del puente shadcn. Recursivo, porque el
      // puente anida dos niveles (`sidebar.accent.foreground` es
      // `text-sidebar-accent-foreground`) y quedarse en uno marca como
      // inventada una clase que sí existe.
      ...aplanarColores(extend.colors),
      // Y lo que no es ni tamaño ni color.
      'left', 'center', 'right', 'justify', 'start', 'end',
      'balance', 'pretty', 'wrap', 'nowrap', 'clip', 'ellipsis',
      'transparent', 'current', 'inherit', 'white', 'black',
    ]);

    const raiz = resolve(__dirname, '../../..');
    const fallos: string[] = [];
    function revisar(dir: string) {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.next', '.turbo'].includes(entrada.name)) continue;
        const ruta = join(dir, entrada.name);
        if (entrada.isDirectory()) {
          revisar(ruta);
          continue;
        }
        if (!ruta.endsWith('.tsx')) continue;
        const contenido = readFileSync(ruta, 'utf8');
        for (const m of contenido.matchAll(/\btext-([a-z0-9]+(?:-[a-z0-9]+)*)\b/g)) {
          const clase = m[1];
          // Los valores arbitrarios (`text-[14px]`) los caza el test de arriba.
          if (clase.startsWith('[')) continue;
          if (!permitidas.has(clase)) fallos.push(`${ruta.slice(raiz.length + 1)} → text-${clase}`);
        }
      }
    }
    for (const carpeta of ['apps/web', 'apps/admin', 'packages/ui/src']) revisar(join(raiz, carpeta));
    expect(
      [...new Set(fallos)],
      'Estas clases `text-` no existen: Tailwind no emite nada y el texto queda del ' +
        'tamaño o color que hereda, sin que falle nada.\n  ' + [...new Set(fallos)].join('\n  '),
    ).toEqual([]);
  }, 30_000);
});
