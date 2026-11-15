import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * El rótulo sobre el título no grita (Mesón, ADR-0034, #1346).
 *
 * `.rotulo` dejó de poner versales en la fase 2, pero veinte pantallas le
 * pasaban el texto YA en mayúsculas —`rotulo="PENDIENTES"`—, así que el CSS
 * no tenía nada que corregir y la captura seguía diciendo «PENDIENTES». Un
 * estilo no arregla un dato: esta guarda mira el dato.
 *
 * Y cuando el rótulo repetía el título («EMPRESAS» sobre «Empresas») se sacó:
 * decir lo mismo dos veces seguidas es ruido, no jerarquía.
 */
const COMPONENTES = join(__dirname, '..', 'components');

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return archivos(p);
    return p.endsWith('.tsx') && !p.endsWith('.test.tsx') ? [p] : [];
  });
}

/** Siglas que se escriben así en cualquier frase. */
const SIGLAS = new Set(['API', 'RUT', 'CSV', 'IA', 'UF', 'CLP']);

describe('el rótulo de la pantalla va en minúscula de oración', () => {
  const rotulos = archivos(COMPONENTES).flatMap((f) => {
    const fuente = fuenteLimpia(readFileSync(f, 'utf8'));
    return [...fuente.matchAll(/rotulo="([^"]+)"/g)].map((m) => ({ archivo: f.slice(COMPONENTES.length + 1), texto: m[1]! }));
  });

  it('encuentra los rótulos (si no, la guarda no mide nada)', () => {
    expect(rotulos.length).toBeGreaterThan(10);
  });

  it('ninguno viene en mayúsculas', () => {
    const gritan = rotulos.filter(({ texto }) => !SIGLAS.has(texto) && texto.length > 2 && texto === texto.toUpperCase());
    expect(gritan, 'rótulos en versales: escríbelos en minúscula de oración').toEqual([]);
  });
});
