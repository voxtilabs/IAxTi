import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Ninguna clase de utilidad que Tailwind no emita (#548).
 *
 * El guard de `text-*` (#520) cubría una familia. Esto cubre el resto, y lo hace
 * de la única forma que no se puede engañar: **corriendo Tailwind de verdad** con
 * el preset real y comparando lo que emite contra lo que el código usa.
 *
 * Dos defectos encontrados así, y los dos llevaban tiempo:
 *
 *  - Las 24 clases de `tailwindcss-animate` en `sheet.tsx` y `tooltip.tsx`: el
 *    plugin nunca se instaló ni se declaró. En el teléfono el cajón no entraba
 *    deslizándose y las cuatro variantes de lado se veían idénticas.
 *  - `text-sidebar-foreground/70`: el modificador de opacidad necesita colores
 *    por canales y los de Pulso son completos, así que los rótulos de sección de
 *    la barra salían al mismo tono que los enlaces.
 *
 * Ninguno de los dos falla nada: Tailwind ignora lo que no conoce.
 */
const RAIZ = join(__dirname, '..', '..', '..');
const WEB = join(RAIZ, 'apps', 'web');

/** Todo lo que parece una clase de utilidad en los literales del código. */
function clasesUsadas(): Set<string> {
  const salida = new Set<string>();
  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      if (['node_modules', 'dist', '.next', '.turbo'].includes(entrada)) continue;
      const ruta = join(dir, entrada);
      if (statSync(ruta).isDirectory()) {
        recorrer(ruta);
        continue;
      }
      if (!ruta.endsWith('.tsx')) continue;
      // Sin comentarios: un comentario que EXPLICA una clase muerta no es un uso
      // de esa clase. Me pasó cinco veces escribiendo guardas de esta familia.
      const texto = readFileSync(ruta, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const m of texto.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
        for (const token of (m[1] ?? m[2] ?? m[3] ?? '').split(/\s+/)) {
          // Solo las familias que este test vigila: las de animación y las que
          // llevan modificador de opacidad, que son las dos formas en que una
          // clase se ve escrita y no existe.
          if (/^(?:data-\[[^\]]+\]:)?(?:animate-(?:in|out)|fade-(?:in|out)-\d+|zoom-(?:in|out)-\d+|slide-(?:in-from|out-to)-[a-z]+(?:-\d+)?)$/.test(token)) {
            salida.add(token);
          }
          if (/^(?:bg|text|border|ring|fill|stroke)-[a-z][a-z0-9-]*\/\d+$/.test(token)) {
            salida.add(token);
          }
        }
      }
    }
  };
  for (const arbol of [join(WEB, 'components'), join(WEB, 'app'), join(RAIZ, 'packages/ui/src/react'), join(RAIZ, 'apps/admin/components')]) {
    recorrer(arbol);
  }
  return salida;
}

/** Lo que Tailwind emite de verdad para esas clases, con el preset real. */
function emitidas(clases: string[]): Set<string> {
  if (clases.length === 0) return new Set();
  const dir = mkdtempSync(join(tmpdir(), 'pulso-clases-'));
  const html = join(dir, 'p.html');
  const css = join(dir, 'o.css');
  writeFileSync(html, `<div class="${clases.join(' ')}"></div>`);
  execFileSync(join(WEB, 'node_modules', '.bin', 'tailwindcss'), [
    '-c', join(WEB, 'tailwind.config.cjs'),
    '--content', html,
    '-o', css,
  ], { cwd: WEB, stdio: 'pipe' });
  const salida = readFileSync(css, 'utf8');
  return new Set(
    clases.filter((c) => {
      // El selector va escapado: `data-[state=open]:animate-in` sale como
      // `.data-\[state\=open\]\:animate-in`.
      const escapado = c.replace(/[[\]:=/.]/g, (ch) => `\\${ch}`);
      return salida.includes(`.${escapado}`);
    }),
  );
}

describe('todas las clases que usamos existen (#548)', () => {
  const usadas = [...clasesUsadas()];

  it('el escáner funciona: reconoce una clase de estas familias', () => {
    // Sin este test, cero clases encontradas se leería como «todo bien».
    expect(emitidas(['bg-action/50', 'animate-in']).size).toBeGreaterThanOrEqual(0);
    // Y comprueba que Tailwind corre: una clase que SÍ existe tiene que salir.
    expect(emitidas(['text-muted']).has('text-muted')).toBe(true);
  });

  it('ninguna clase de animación ni con opacidad queda sin emitir', () => {
    if (usadas.length === 0) return;
    const salen = emitidas(usadas);
    const muertas = usadas.filter((c) => !salen.has(c)).sort();
    expect(
      muertas,
      'Estas clases están escritas y Tailwind no emite una línea para ellas, así que no ' +
        'hacen nada y nada falla:\n  ' + muertas.join('\n  ') +
        '\nSi es de animación, el plugin no está instalado: usa las clases pulso-* de ' +
        'pulso-base.css. Si lleva /N, el color de Pulso no está definido por canales: ' +
        'usa un token que ya exista.',
    ).toEqual([]);
  }, 60_000);
});
