import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MODE_INIT_SCRIPT } from '../src/mode';

const UI = resolve(__dirname, '..');
const REPO = resolve(UI, '../..');
const tokensCss = readFileSync(join(UI, 'pulso-tokens.css'), 'utf8');

function varsOf(block: string): Set<string> {
  return new Set([...block.matchAll(/--[\w-]+(?=\s*:)/g)].map((m) => m[0]));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.next', '.turbo', '.git', 'marca'].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx?|css|mjs|cjs)$/.test(entry)) out.push(path);
  }
  return out;
}

describe('sistema Pulso (documento voxtilabs/branding v1.1)', () => {
  const [dia, noche] = tokensCss.split('[data-mode="noche"]');

  it('día y noche definen exactamente el mismo set de tokens', () => {
    const vDia = varsOf(dia);
    const vNoche = varsOf(noche);
    expect([...vDia].sort()).toEqual([...vNoche].sort());
    expect(vDia.size).toBeGreaterThanOrEqual(25);
  });

  it('los valores clave son los del documento', () => {
    // El azul de acción es idéntico en los dos modos (§1).
    expect([...tokensCss.matchAll(/--action:#3D5AFE/g)]).toHaveLength(2);
    // action-text se recalibra por modo (§1).
    expect(dia).toContain('--action-text:#2739D6');
    expect(noche).toContain('--action-text:#93A2FF');
    // Ni blanco puro de texto nocturno ni negro puro de fondo (§10).
    expect(noche).not.toMatch(/--text:#FFFFFF/i);
    expect(noche).not.toMatch(/--bg:#000000/i);
    expect(noche).toContain('--bg:#0B0D14');
  });

  it('NINGÚN hex suelto fuera de pulso-tokens.css (apps y packages)', () => {
    const conHex: string[] = [];
    for (const base of [join(REPO, 'apps'), join(REPO, 'packages')]) {
      for (const file of walk(base)) {
        if (file.endsWith('pulso-tokens.css')) continue;
        if (file.endsWith('pulso.test.ts')) continue; // este archivo cita hex del documento
        // El snippet del webchat (#46) corre en SITIOS DE TERCEROS, donde las
        // variables Pulso no existen: sus dos hex (acción y blanco) son el
        // único caso legítimo fuera de los tokens.
        if (file.endsWith('public/webchat.js')) continue;
        const content = readFileSync(file, 'utf8');
        // Hex de color CSS/JSX; el límite de 8 deja fuera ids y hashes largos.
        //
        // Un `#` seguido de SOLO DÍGITOS no se marca: es una referencia a un
        // issue (`#183`), no un color. Esta regla nos mordió tres veces —y
        // siempre tarde, porque turbo cachea este test y el fallo aparece en
        // el PR siguiente—. El precio es dejar pasar un color de tres cifras
        // sin letras (`#123`), que nadie escribe: los tokens de Pulso son de
        // seis y con letras.
        const hex = [...content.matchAll(/#([0-9a-fA-F]{3,8})\b(?![\w-])/g)]
          .map((m) => m[1])
          .filter((h) => [3, 4, 6, 8].includes(h.length))
          .filter((h) => /[a-fA-F]/.test(h));
        if (hex.length > 0) {
          conHex.push(`${file.replace(REPO + '/', '')} → #${hex[0]}`);
        }
      }
    }
    expect(
      conHex,
      `Hex suelto prohibido por Pulso:\n${conHex.join('\n')}\nUsa las variables de pulso-tokens.css.`,
    ).toEqual([]);
  });

  it('NINGÚN emoji en la interfaz (regla Pulso)', () => {
    // La regla lo prohíbe con todas sus letras y no lo miraba nadie: había
    // ocho —🔒 en el menú, 🔔 en la campana, 👍👎 en el copiloto y ✦ en
    // cuatro sitios—. Y no fue una elección: no había ningún set de iconos
    // instalado (#292).
    //
    // Un emoji se dibuja con la fuente del sistema: se ve distinto en cada
    // máquina, no hereda el color del texto, no tiene estados y no escala
    // con la tipografía.
    const EMOJI =
      /[\u{1F300}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
    const conEmoji: string[] = [];
    for (const base of [join(REPO, 'apps'), join(REPO, 'packages')]) {
      for (const file of walk(base)) {
        if (!/\.tsx$/.test(file)) continue;
        if (file.endsWith('pulso.test.ts')) continue;
        const linea = readFileSync(file, 'utf8')
          .split('\n')
          .findIndex((l) => EMOJI.test(l));
        if (linea >= 0) conEmoji.push(`${file.replace(REPO + '/', '')}:${linea + 1}`);
      }
    }
    expect(
      conEmoji,
      `Emoji en la interfaz (Pulso los prohíbe). Usa un icono:\n  ${conEmoji.join('\n  ')}`,
    ).toEqual([]);
  });

  it('el script de modo aplica prefers-color-scheme y respeta la elección guardada', () => {
    expect(MODE_INIT_SCRIPT).toContain('prefers-color-scheme: dark');
    expect(MODE_INIT_SCRIPT).toContain("localStorage.getItem('pulso-mode')");
    expect(MODE_INIT_SCRIPT).toContain('dataset.mode');
  });

  it('la marca está completa, con el lockup de tokens que lee variables', () => {
    const marca = readdirSync(join(UI, 'marca'));
    for (const f of ['voxti-tokens.svg', 'voxti-tinta.svg', 'voxti-claro.svg', 'voxti-mono.svg', 'voxti-isotipo-cuadrado.svg']) {
      expect(marca).toContain(f);
    }
    const tokensSvg = readFileSync(join(UI, 'marca', 'voxti-tokens.svg'), 'utf8');
    expect(tokensSvg).toContain('var(--text)');
    expect(tokensSvg).toContain('var(--action)');

    // Y la de IAxTi, que es la que ve el cliente (#296). VoxTi Labs es quien
    // lo hace y se queda en SuperAdmin y en el pie.
    for (const f of [
      'iaxti-tokens.svg',
      'iaxti-tinta.svg',
      'iaxti-claro.svg',
      'iaxti-mono.svg',
      'iaxti-isotipo.svg',
      'iaxti-isotipo-cuadrado.svg',
    ]) {
      expect(marca).toContain(f);
    }
    const iaxti = readFileSync(join(UI, 'marca', 'iaxti-tokens.svg'), 'utf8');
    expect(iaxti).toContain('var(--text)');
    expect(iaxti).toContain('var(--action)');
    // Sin fallback hex: `marca-svg.ts` la inlinea y el test de arriba
    // prohíbe hex en los .ts. Un `var(--action, #3D5AFE)` lo haría fallar
    // en el PR siguiente, cuando turbo deje de cachear.
    expect(iaxti).not.toMatch(/#[0-9A-Fa-f]{6}/);
  });

  it('el preset de Tailwind prohíbe dark: (selector por data-mode) y mapea los 8 nombres del documento', async () => {
    const modulo = (await import('../tailwind-preset.cjs')) as { default?: Record<string, never> };
    const preset = (modulo.default ?? modulo) as {
      darkMode: unknown;
      theme: { extend: { colors: Record<string, unknown>; borderRadius: Record<string, string> } };
    };
    expect(preset.darkMode).toEqual(['selector', '[data-mode="noche"]']);
    const colors = preset.theme.extend.colors;
    for (const key of ['bg', 'raised', 'rest', 'line', 'ink', 'body', 'muted', 'action']) {
      expect(colors, `falta el color "${key}" del documento §11`).toHaveProperty(key);
    }
    expect(preset.theme.extend.borderRadius).toEqual({
      boton: '999px', campo: '14px', tarjeta: '22px', bloque: '28px',
    });
  });
});
