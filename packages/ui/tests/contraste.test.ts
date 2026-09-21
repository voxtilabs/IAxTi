import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const [dia, noche] = readFileSync(join(__dirname, '../pulso-tokens.css'), 'utf8').split('[data-mode="noche"]');
const luminancia = (hex: string) => {
  const rgb = hex.match(/[a-f\d]{2}/gi)!.map((c) => parseInt(c, 16) / 255)
    .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
};

for (const [modo, bloque] of [['día', dia], ['noche', noche]]) {
  const tokens = Object.fromEntries([...bloque.matchAll(/(--[\w-]+):\s*(#[a-f\d]{6})\s*;/gi)].map((m) => [m[1], m[2]]));
  const contraste = (a: string, b: string) => {
    expect(tokens[a], `falta el token ${a}`).toBeDefined();
    expect(tokens[b], `falta el token ${b}`).toBeDefined();
    const luces = [luminancia(tokens[a]), luminancia(tokens[b])].sort((x, y) => y - x);
    return (luces[0] + .05) / (luces[1] + .05);
  };
  describe(`legibilidad de Pulso Vivo en ${modo}`, () => {
    for (const fondo of ['--bg', '--bg-raised', '--bg-rest', '--canvas', '--panel', '--chrome', '--hero-surface', '--field-bg']) {
      it(`texto normal, secundario y enlaces pasan AA sobre ${fondo}`, () => {
        for (const texto of ['--text', '--text-body', '--text-muted', '--action-text']) {
          expect(contraste(texto, fondo), `${texto} sobre ${fondo}`).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
    it('estados y botones conservan contraste de texto normal', () => {
      for (const rol of ['action', 'warn', 'good', 'bad']) {
        expect(contraste(`--${rol}-text`, `--${rol}-soft`), rol).toBeGreaterThanOrEqual(4.5);
      }
      for (const fondo of ['--action', '--action-hover', '--bad']) expect(contraste('--on-action', fondo), fondo).toBeGreaterThanOrEqual(4.5);
    });
    it('los límites de campo se distinguen del fondo', () => {
      for (const fondo of ['--field-bg', '--panel']) {
        expect(contraste('--border-strong', fondo)).toBeGreaterThanOrEqual(3);
      }
    });
    it('el foco se distingue en todas las superficies de interacción', () => {
      for (const fondo of ['--bg', '--bg-raised', '--bg-rest', '--canvas', '--panel', '--chrome', '--hero-surface', '--field-bg', '--action-soft']) {
        expect(contraste('--focus', fondo), `foco sobre ${fondo}`).toBeGreaterThanOrEqual(3);
      }
    });
    it('el placeholder del campo conserva legibilidad', () => {
      expect(contraste('--text-faint', '--field-bg')).toBeGreaterThanOrEqual(4.5);
    });
  });
}
