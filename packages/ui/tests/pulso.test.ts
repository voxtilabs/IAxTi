import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';
import { MODE_INIT_SCRIPT } from '../src/mode';

const UI = resolve(__dirname, '..');
const REPO = resolve(UI, '../..');
const tokensCss = readFileSync(join(UI, 'pulso-tokens.css'), 'utf8');

/**
 * Los dos escáneres de las guardas que recorren el árbol (#1304).
 *
 * Viven acá afuera y no dentro de su `it` por una razón concreta: así la
 * prueba que los mide les pasa un texto a mano y ejercita EL MISMO código
 * que recorre el repo. Metidos adentro, lo único que se podría probar es una
 * copia, y una copia que se comporta distinto es peor que no probar nada.
 *
 * Los dos limpian la fuente, que es lo que pide la regla de testing del repo
 * para toda guarda que escanee código: un carácter prohibido dentro del
 * comentario que lo EXPLICA no es ese carácter en la interfaz.
 */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

/** La primera línea con un emoji, o -1. Base 1, como la cuenta un editor. */
export function lineaConEmoji(contenido: string): number {
  // `fuenteLimpia` reemplaza por espacios y CONSERVA los saltos, así que el
  // número que sale de acá sigue siendo el de la línea de verdad.
  const i = fuenteLimpia(contenido).split('\n').findIndex((l) => EMOJI.test(l));
  return i < 0 ? -1 : i + 1;
}

/**
 * Los hex sueltos del texto, sin el `#`.
 *
 * El límite de 8 deja fuera ids y hashes largos. Un `#` seguido de SOLO
 * DÍGITOS no se marca: es una referencia a un issue. Limpiar la fuente NO
 * alcanzó para soltar ese filtro —lo intenté en #1304— porque las
 * referencias no viven solo en comentarios, viven en TÍTULOS DE PRUEBAS
 * (`describe('… (#1216)')`), que son cadenas y `fuenteLimpia` las conserva a
 * propósito. El precio es que un color de tres cifras sin letras (`#123`)
 * pasa: nadie lo escribe, pero queda dicho que es un agujero conocido.
 */
export function hexSueltos(contenido: string): string[] {
  return [...fuenteLimpia(contenido).matchAll(/#([0-9a-fA-F]{3,8})\b(?![\w-])/g)]
    .map((m) => m[1])
    .filter((h) => [3, 4, 6, 8].includes(h.length))
    .filter((h) => /[a-fA-F]/.test(h));
}

function varsOf(block: string): Set<string> {
  return new Set([...block.matchAll(/--[\w-]+(?=\s*:)/g)].map((m) => m[0]));
}

/**
 * Lo que esta guarda NO escanea, y de dónde sale la lista (#1087).
 *
 * `GENERADO` son los directorios que `.gitignore` declara: no los escribió
 * nadie y no se versionan. Faltaban `test-results`, `playwright-report` y
 * `coverage`, y el agujero se abría por el camino que el repo RECOMIENDA —
 * correr el e2e y después `pnpm antes-de-empujar`—: Playwright guarda en la
 * traza los CSS que el navegador descargó, y uno de ellos trae un `#fff`.
 * Resultado: un rojo que no tiene nada que ver con el cambio de quien lo ve,
 * en una guarda de 190 ms que hay que leer entera para descartar.
 *
 *     + "apps/web/test-results/.playwright-artifacts-0/traces/…css → #fff"
 *
 * Lo pagué: atribuí ese rojo a #988 antes de mirar la ruta del hallazgo. Y es
 * el peor resultado posible para una guarda —«una guarda que grita de más se
 * apaga igual de rápido que una que no grita»—, así que no es cosmético.
 *
 * `marca` es distinto: NO es generado y sí se versiona. Queda fuera porque es
 * el logo y no la interfaz, que es la distinción que Pulso hace cuando dice
 * que el isotipo es decorativo. Por eso va en su propia constante: mezclarlo
 * con lo generado haría creer que también lo ignora git.
 */
const GENERADO = [
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  'test-results',
  'playwright-report',
  // Las capturas del shell: se generan a mano para el PR y no se versionan.
  'capturas',
  // Y la que más pesaba: los worktrees de los workflows (#601) son repos
  // EMBEBIDOS, o sea una copia completa del código. Con uno presente, esta
  // guarda escaneaba un árbol entero duplicado y cualquier hallazgo salía por
  // partida doble, con una ruta que no existe en el repo de verdad. Lo
  // encontró la prueba de abajo al escribirla, no yo.
  'worktrees',
];
const FUERA_DEL_SISTEMA = ['.git', 'marca'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (GENERADO.includes(entry) || FUERA_DEL_SISTEMA.includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx?|css|mjs|cjs)$/.test(entry)) out.push(path);
  }
  return out;
}

/**
 * La lista de la guarda y `.gitignore` no se separan (#1087).
 *
 * El defecto no fue que faltara `test-results`: fue que **son dos
 * declaraciones de la misma cosa** y se separaron sin que nada lo notara. La
 * segunda vez iba a ser con `playwright-report` o con `coverage`.
 *
 * Así que la fuente de verdad es `.gitignore`, y esta prueba falla si declara
 * un directorio que la guarda igual escanea. No al revés: `GENERADO` puede
 * tener de más —un nombre que git ignora en otra parte del árbol— sin que eso
 * sea un problema.
 */
describe('lo que la guarda ignora sale de .gitignore (#1087)', () => {
  it('ningún directorio ignorado por git queda sin ignorar acá', () => {
    const gitignore = readFileSync(join(REPO, '.gitignore'), 'utf8');
    const ignorados = gitignore
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!') && l.endsWith('/'))
      // Solo el último segmento: `apps/web/test-results/` se ignora por el
      // nombre del directorio, que es como `walk` decide.
      .map((l) => l.replace(/\/$/, '').split('/').pop()!)
      .filter(Boolean);
    const sinIgnorar = [...new Set(ignorados)].filter((n) => !GENERADO.includes(n) && !FUERA_DEL_SISTEMA.includes(n));
    expect(
      sinIgnorar,
      'Estos directorios los ignora `.gitignore` y la guarda los escanea igual.\n' +
        'Agregalos a `GENERADO` en este archivo: lo que no versionamos no se mide.\n  ',
    ).toEqual([]);
  });

  it('y el texto de una traza de Playwright no cuenta como hex suelto', () => {
    // La forma exacta del hallazgo falso, para que la mordida sea del defecto
    // y no de una ruta inventada.
    const falso = 'apps/web/test-results/.playwright-artifacts-0/traces/resources/abc.css';
    const nombre = falso.split('/').find((p) => GENERADO.includes(p));
    expect(nombre).toBe('test-results');
  });
});

describe('sistema Pulso (branding v1.1 y evolución de IAxTi, ADR-0021/0022)', () => {
  const [dia, noche] = tokensCss.split('[data-mode="noche"]');

  it('día y noche definen exactamente el mismo set de tokens', () => {
    const vDia = varsOf(dia);
    const vNoche = varsOf(noche);
    expect([...vDia].sort()).toEqual([...vNoche].sort());
    expect(vDia.size).toBeGreaterThanOrEqual(25);
  });

  /**
   * La paleta es la canónica de Pulso 1.1 (#706).
   *
   * Esta prueba fijaba la paleta cian/hielo de IAxTi. No era una decisión de
   * marca: era una desviación, y lo que la delata no es el gusto sino los
   * archivos de marca — `iaxti-tokens.svg` pide `var(--text, #12141C)` y
   * `var(--text-muted, #6E7488)` como respaldo, que son los canónicos. El
   * lockup va inline y toma los tokens de la página, así que con la paleta
   * anterior se dibujaba con colores que su propio archivo no esperaba.
   *
   * La referencia vive en `voxtilabs/IAxTi-Branding/pulso/tokens.css`, y es la
   * misma que corre en VOXIA 2.
   */
  it('aplica la paleta canónica de Pulso 1.1', () => {
    // El azul de acción es idéntico en los dos modos (§1).
    expect([...tokensCss.matchAll(/--action:#3D5AFE/g)]).toHaveLength(2);
    // Las superficies del sistema, literales.
    expect(dia).toContain('--bg:#FFFFFF');
    expect(dia).toContain('--bg-raised:#F7F8FD');
    expect(dia).toContain('--text:#12141C');
    expect(noche).toContain('--bg:#0B0D14');
    expect(noche).toContain('--bg-raised:#141826');
    // action-text se recalibra por modo (§1): un azul oscuro sobre fondo negro
    // no se lee, y uno saturado como texto vibra.
    expect(dia).toContain('--action-text:#2739D6');
    expect(noche).toContain('--action-text:#93A2FF');
    // Ni blanco puro de texto nocturno ni negro puro de fondo (§10).
    expect(noche).not.toMatch(/--text:#FFFFFF/i);
    expect(noche).not.toMatch(/--bg:#000000/i);
  });

  /**
   * Las tres superficies, y solo tres (#706).
   *
   * Pulso dice que hay `--bg`, `--bg-raised` y `--bg-rest`, y que una cuarta
   * significa que se está anidando de más. Acá había seis: `--canvas`,
   * `--panel`, `--chrome` y `--hero-surface` traían cada una su propio color.
   * Los nombres siguen porque los piden 62 pantallas, pero ya no aportan un
   * color nuevo. Si alguien vuelve a darles uno propio, esto se cae.
   */
  it('las superficies de más no inventan un color nuevo', () => {
    for (const [bloque, nombre, base, elevada] of [
      [dia, 'día', '#FFFFFF', '#F7F8FD'],
      [noche, 'noche', '#0B0D14', '#141826'],
    ] as const) {
      expect(bloque, `${nombre}: --canvas`).toContain(`--canvas:${base}`);
      expect(bloque, `${nombre}: --chrome`).toContain(`--chrome:${base}`);
      expect(bloque, `${nombre}: --panel`).toContain(`--panel:${elevada}`);
      expect(bloque, `${nombre}: --hero-surface`).toContain(`--hero-surface:${elevada}`);
    }
  });

  /**
   * Los colores del isotipo se quedan, y son de la MARCA (#706).
   *
   * El isotipo de IAxTi es jelly y translúcido: esos colores pertenecen al
   * logo, no a la interfaz. Pulso hace esa misma distinción cuando dice que el
   * isotipo es la única excepción a «el azul no decora». Borrarlos al traer la
   * paleta canónica habría dejado el logo sin sus colores.
   */
  it('conserva los tokens de marca del isotipo', () => {
    for (const token of ['--jelly-ice', '--jelly-sky', '--jelly-deep', '--jelly-shadow', '--jelly-glint', '--brand-warm']) {
      expect(dia, token).toContain(`${token}:`);
      expect(noche, token).toContain(`${token}:`);
    }
    // Y no se mudan al sistema: el azul de acción sigue siendo el de acción.
    expect(dia).not.toContain('--action:#24D0E7');
  });

  /**
   * Los escáneres distinguen el comentario del código (#1304).
   *
   * Las dos guardas que recorren el árbol leían la fuente CRUDA, contra la
   * regla de testing del repo. Lo que eso costaba:
   *
   *  - La de emoji puso roja la rama de #1301 por un `✕` dentro del
   *    comentario que EXPLICA cómo se cierra un panel. El botón de verdad usa
   *    un icono dibujado; lo prohibido estaba en la explicación.
   *  - La de hex ya documentaba haber sido mordida por lo mismo tres veces, y
   *    lo había resuelto angostando la expresión en vez de limpiar la fuente
   *    — el camino que #569 dice que no se tome.
   *
   * Esto le pasa texto a mano a las MISMAS funciones que recorren el repo, no
   * a una copia: una copia que se comporta distinto es peor que no probar.
   */
  it('lo prohibido en un comentario no cuenta; en el código sí', () => {
    expect(lineaConEmoji('const x = 1; // se cierra con la ✕\n')).toBe(-1);
    expect(lineaConEmoji('const cerrar = "✕";\n')).toBe(1);
    // Y el número de línea sobrevive a la limpieza, que es de lo que depende
    // que el mensaje de la guarda mande al lugar correcto.
    expect(lineaConEmoji('uno\n// dos ✕\ntres\nconst c = "✕";\n')).toBe(4);

    expect(hexSueltos('// el token era #AABBCC antes de Pulso')).toEqual([]);
    expect(hexSueltos("const c = '#AABBCC';")).toEqual(['AABBCC']);
    // Una referencia a un issue no es un color, viva donde viva: en los
    // títulos de prueba son cadenas y la limpieza no las toca.
    expect(hexSueltos("describe('el apagado espera (#1216)', () => {})")).toEqual([]);
  });

  it('NINGÚN hex suelto fuera de pulso-tokens.css (apps y packages)', () => {
    const conHex: string[] = [];
    for (const base of [join(REPO, 'apps'), join(REPO, 'packages')]) {
      for (const file of walk(base)) {
        if (file.endsWith('pulso-tokens.css')) continue;
        if (file.endsWith('pulso.test.ts')) continue; // este archivo cita hex del documento
        /**
         * Lo que NO se renderiza en nuestra aplicación.
         *
         * Pulso vive en variables CSS, y hay dos medios donde esas variables
         * sencillamente no existen. No es una concesión de estilo: es que el
         * mecanismo no llega hasta ahí.
         *
         * - El snippet del webchat (#46) corre en SITIOS DE TERCEROS.
         * - La plantilla de correo (#1258) corre en Gmail y en Outlook, que
         *   borran `<style>` y no tienen `:root`. Un color sin declarar en
         *   línea termina invertido por el modo oscuro del cliente, que es
         *   peor que un hex escrito a mano.
         *
         * Son dos, y la lista no debería crecer sin esa misma justificación:
         * «el medio no soporta variables CSS», no «me quedaba más cómodo».
         */
        if (file.endsWith('public/webchat.js')) continue;
        if (file.endsWith('notifications/application/email.ts')) continue;
        const hex = hexSueltos(readFileSync(file, 'utf8'));
        if (hex.length > 0) {
          conHex.push(`${file.replace(REPO + '/', '')} → #${hex[0]}`);
        }
      }
    }
    expect(
      conHex,
      `Hex suelto prohibido por Pulso:\n${conHex.join('\n')}\nUsa las variables de pulso-tokens.css.`,
    ).toEqual([]);
    // Plazo explícito: recorre apps/ y packages/ enteros leyendo cada .ts,
    // .tsx, .css y .cjs. Solo tarda 100 ms, pero con la suite completa en
    // paralelo pasaba de los 5 s por omisión y fallaba por TIEMPO diciendo
    // "hex suelto" — el peor fallo posible, porque manda a buscar un color
    // que no existe. Mismo plazo que las otras guardas que recorren el árbol.
  }, 30_000);

  it('NINGÚN emoji en la interfaz (regla Pulso)', () => {
    // La regla lo prohíbe con todas sus letras y no lo miraba nadie: había
    // ocho —🔒 en el menú, 🔔 en la campana, 👍👎 en el copiloto y ✦ en
    // cuatro sitios—. Y no fue una elección: no había ningún set de iconos
    // instalado (#292).
    //
    // Un emoji se dibuja con la fuente del sistema: se ve distinto en cada
    // máquina, no hereda el color del texto, no tiene estados y no escala
    // con la tipografía.
    const conEmoji: string[] = [];
    for (const base of [join(REPO, 'apps'), join(REPO, 'packages')]) {
      for (const file of walk(base)) {
        if (!/\.tsx$/.test(file)) continue;
        if (file.endsWith('pulso.test.ts')) continue;
        const linea = lineaConEmoji(readFileSync(file, 'utf8'));
        if (linea > 0) conEmoji.push(`${file.replace(REPO + '/', '')}:${linea}`);
      }
    }
    expect(
      conEmoji,
      `Emoji en la interfaz (Pulso los prohíbe). Usa un icono:\n  ${conEmoji.join('\n  ')}`,
    ).toEqual([]);
    // El mismo recorrido y el mismo motivo que la guarda de hex.
  }, 30_000);

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
    // Sin castear la importación: con `allowJs` en el typecheck (#507) el .cjs
    // ya tiene tipos inferidos, y forzarlo a `Record<string, never>` era decirle
    // al compilador que el preset está vacío.
    const modulo = await import('../tailwind-preset.cjs');
    const preset = (modulo.default ?? modulo) as unknown as {
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
