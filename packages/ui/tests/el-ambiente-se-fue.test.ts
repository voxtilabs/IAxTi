import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El ambiente de Pulso Vivo se fue, no quedó apagado (#1346).
 *
 * Mesón lo dejó en transparente (fase 1) para no tocar treinta reglas a la
 * vez: `--ambient-*` valían `rgb(0 0 0 / 0)` y tres `::before` seguían
 * pintando degradados radiales de nada sobre el marco, la portada y el
 * acceso. Un token transparente es una invitación: basta cambiarle el valor
 * para que el marco vuelva a tener color, y el marco de Mesón es quieto.
 *
 * Lo que SÍ queda con `radial-gradient` es la máscara del borde picado de la
 * boleta del asistente, que es Mesón y no pinta color: recorta.
 */
const UI = join(__dirname, '..');
const tokens = readFileSync(join(UI, 'pulso-tokens.css'), 'utf8');
const capa = readFileSync(join(UI, 'pulso-vivo.css'), 'utf8');

describe('el ambiente de Pulso Vivo', () => {
  it('no queda ningún token de ambiente ni de brillo de superficie', () => {
    expect(tokens).not.toMatch(/--ambient-[a-z-]+\s*:/);
    expect(tokens).not.toMatch(/--surface-glint\s*:/);
    expect(capa).not.toMatch(/var\(--(ambient|surface-glint)/);
  });

  it('el único degradado radial es una máscara', () => {
    const lineas = capa.split('\n').filter((l) => l.includes('radial-gradient('));
    expect(lineas.length).toBeGreaterThan(0);
    for (const l of lineas) expect(l, l.trim()).toMatch(/^\s*(-webkit-)?mask\s*:/);
  });
});
