import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Elevación de overlays (ADR-0018); material y superficies en Pulso Vivo (ADR-0021).
 *
 * Pulso prohibía las sombras sin excepción. La de overlays está tokenizada, y
 * significa algo concreto: *esto está por encima del contenido y se puede
 * cerrar*. Una sombra que está en todas partes no dice nada, y es
 * exactamente cómo se llega a la interfaz de plantilla que #290 quiere
 * evitar.
 *
 * El riesgo real no es que alguien decida permitirlas: es que lleguen sin
 * que nadie decida nada. `npx shadcn add <lo-que-sea>` trae `shadow-lg`,
 * `shadow-md` y `shadow-sm` en sus componentes; al traer la barra lateral
 * (#295) vinieron tres de un saque.
 */
const UI = join(__dirname, '..');
const COMPONENTES = join(UI, 'src', 'react');

/** Los seis que se superponen al contenido. La lista es la decisión. */
const FLOTAN = new Set([
  'dialog.tsx',
  'dropdown-menu.tsx',
  'select.tsx',
  'tooltip.tsx',
  'sheet.tsx',
  'command.tsx',
]);

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) fuentes(ruta, acc);
    else if (entrada.endsWith('.tsx') || entrada.endsWith('.ts')) acc.push(ruta);
  }
  return acc;
}

/** `shadow-none` no cuenta: quita una sombra, no la pone. */
const SOMBRA = /\bshadow-(?!none\b)[a-z0-9[\]()_-]+/g;

describe('elevación de overlays sin efectos arbitrarios en componentes', () => {
  const archivos = fuentes(COMPONENTES);

  it('hay componentes que mirar', () => {
    expect(archivos.length).toBeGreaterThan(15);
  });

  it('el token está definido en los DOS modos, y en un solo archivo', () => {
    const base = readFileSync(join(UI, 'pulso-base.css'), 'utf8');
    expect(base.match(/--elevacion-flotante\s*:/g) ?? []).toHaveLength(2);
    // En noche tiene que ser OTRO valor: sobre fondo oscuro una sombra
    // clara no existe.
    const valores = [...base.matchAll(/--elevacion-flotante\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(new Set(valores).size).toBe(2);

    const marca = readFileSync(join(UI, 'pulso-tokens.css'), 'utf8');
    expect(
      marca.includes('--elevacion-flotante'),
      'el token histórico de overlays vive solo en pulso-base.css; los de material están en pulso-tokens.css',
    ).toBe(false);
  });

  it('solo los overlays solicitan clases shadow; las superficies usan la capa compartida', () => {
    const intrusos: string[] = [];
    for (const archivo of archivos) {
      const nombre = archivo.split('/').pop()!;
      if (FLOTAN.has(nombre)) continue;
      const texto = readFileSync(archivo, 'utf8');
      // Los comentarios explican por qué NO hay sombra; no cuentan.
      const sinComentarios = texto
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
      for (const m of sinComentarios.match(SOMBRA) ?? []) {
        intrusos.push(`${nombre}: ${m}`);
      }
    }
    expect(
      intrusos,
      'Sombra fuera de los seis componentes que flotan:\n  ' +
        intrusos.join('\n  ') +
        '\nLa elevación significa "esto está por encima". Una tarjeta no flota.',
    ).toEqual([]);
  });

  it('los que flotan usan SOLO `shadow-flotante`', () => {
    const ajenas: string[] = [];
    for (const archivo of archivos) {
      const nombre = archivo.split('/').pop()!;
      if (!FLOTAN.has(nombre)) continue;
      const texto = readFileSync(archivo, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
      for (const m of texto.match(SOMBRA) ?? []) {
        if (m !== 'shadow-flotante') ajenas.push(`${nombre}: ${m}`);
      }
    }
    expect(
      ajenas,
      'Sombras que no son la del sistema:\n  ' +
        ajenas.join('\n  ') +
        '\nVienen del registro de shadcn. Cámbialas por `shadow-flotante`.',
    ).toEqual([]);
  });

  it('cada uno de los seis la lleva de verdad', () => {
    const sinPoner = [...FLOTAN].filter(
      (n) => !readFileSync(join(COMPONENTES, 'ui', n), 'utf8').includes('shadow-flotante'),
    );
    expect(sinPoner, `declarados como flotantes y sin elevación: ${sinPoner.join(', ')}`).toEqual([]);
  });

  it('el preset declara la clase una sola vez', () => {
    const preset = readFileSync(join(UI, 'tailwind-preset.cjs'), 'utf8');
    // Un segundo bloque `boxShadow` en `extend` no da error: la segunda
    // clave gana y la primera desaparece en silencio. Me pasó escribiendo
    // esto.
    const bloques = preset.match(/^\s*boxShadow:\s*\{/gm) ?? [];
    expect(bloques, 'hay más de un bloque boxShadow en el preset').toHaveLength(1);
    expect(preset).toContain("flotante: 'var(--elevacion-flotante)'");
  });
});
