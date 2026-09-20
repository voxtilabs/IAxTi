import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Un ítem del menú que lleva a un 404.
 *
 * La navegación NO la escribe el frontend: sale de `GET /me/modules`, que
 * devuelve el `nav` declarado en cada `module.yaml`. Es a propósito —"el
 * frontend jamás hardcodea qué módulos existen"— y tiene un costo: el
 * manifiesto puede prometer una ruta que nadie construyó, y nada se queja
 * hasta que un cliente hace clic.
 *
 * Pasó: `calendar` declara `/agenda` y esa página no existe. El módulo es
 * `plan_min: base` y está activo, así que el ítem le aparece a cualquiera
 * con `calendar.read`.
 *
 * Y al revés: una página construida que ningún `nav` menciona es una
 * función terminada a la que no se llega por ningún lado.
 */
const RAIZ = join(__dirname, '..', '..', '..');
const MODULOS = join(RAIZ, 'packages', 'modules');
const APP = join(__dirname, '..', 'app');

/** Las rutas que el menú promete, con el módulo que las declara. */
function rutasDelMenu(): Array<{ modulo: string; path: string }> {
  const salida: Array<{ modulo: string; path: string }> = [];
  for (const modulo of readdirSync(MODULOS)) {
    const yaml = join(MODULOS, modulo, 'module.yaml');
    if (!existsSync(yaml)) continue;
    const texto = readFileSync(yaml, 'utf8');
    const bloque = /^nav:\s*\n((?:\s+.*\n)+?)(?=^\S|$)/m.exec(texto);
    if (!bloque) continue;
    for (const m of bloque[1].matchAll(/path:\s*([^\s,}]+)/g)) {
      salida.push({ modulo, path: m[1] });
    }
  }
  return salida;
}

/** Las páginas que existen de verdad, como rutas. */
function paginas(dir = APP, prefijo = ''): string[] {
  const salida: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      salida.push(...paginas(join(dir, e.name), `${prefijo}/${e.name}`));
    } else if (e.name === 'page.tsx') {
      salida.push(prefijo || '/');
    }
  }
  return salida;
}

/** `/contactos/[id]` cubre `/contactos/loquesea`. */
function existeRuta(ruta: string, todas: string[]): boolean {
  return todas.some((p) => {
    if (p === ruta) return true;
    const patron = '^' + p.replace(/\[[^\]]+\]/g, '[^/]+') + '$';
    return new RegExp(patron).test(ruta);
  });
}

describe('el menú no promete páginas que no existen', () => {
  const menu = rutasDelMenu();
  const todas = paginas();

  it('hay algo que mirar', () => {
    expect(menu.length).toBeGreaterThanOrEqual(10);
    expect(todas.length).toBeGreaterThanOrEqual(10);
  });

  it('cada ruta del nav tiene su página', () => {
    const rotas = menu.filter((x) => !existeRuta(x.path, todas));
    expect(
      rotas,
      'Estos ítems salen en el menú y llevan a un 404:\n' +
        rotas.map((x) => `  ${x.path} (declarado por ${x.modulo})`).join('\n') +
        '\nO se construye la página, o se saca del `nav` hasta que exista.',
    ).toEqual([]);
  });

  it('cada página de ajustes se alcanza desde el menú', () => {
    // Una página terminada que ningún nav menciona es trabajo que nadie
    // puede usar. Solo se revisan las de `/ajustes`: las demás se alcanzan
    // desde dentro del producto (una ficha, un detalle).
    const enMenu = new Set(menu.map((x) => x.path));
    const huerfanas = todas.filter(
      (p) => p.startsWith('/ajustes/') && !p.includes('[') && !enMenu.has(p),
    );
    expect(
      huerfanas,
      'Estas páginas existen y no se llega a ellas desde ningún menú:\n' +
        huerfanas.map((p) => `  ${p}`).join('\n'),
    ).toEqual([]);
  });
});

/**
 * Lo mismo, para los pasos de la puesta en marcha.
 *
 * Cada paso declara dónde se resuelve (`ruta`) junto a su definición, por
 * el mismo motivo por el que el `nav` vive en el manifiesto: el módulo sabe
 * dónde está su cosa. Y por el mismo motivo hace falta esta guarda — al
 * escribirlo puse `/ajustes/negocio`, que no existe: el paso "Cuéntanos de
 * tu negocio" se resuelve en `/ajustes/ia`, donde está el configurador.
 */
describe('los pasos de la puesta en marcha llevan a alguna parte', () => {
  const fuente = readFileSync(
    join(RAIZ, 'packages', 'modules', 'organizations', 'domain', 'onboarding-pasos.ts'),
    'utf8',
  );
  const rutas = [...fuente.matchAll(/ruta:\s*'([^']+)'/g)].map((m) => m[1]);
  const todas = paginas();

  it('hay pasos con ruta que mirar', () => {
    expect(rutas.length).toBeGreaterThanOrEqual(4);
  });

  it('cada ruta declarada existe', () => {
    const rotas = rutas.filter((r) => !existeRuta(r, todas));
    expect(
      rotas,
      'Estos pasos mandan al negocio a un 404 en su primer día:\n' +
        rotas.map((r) => `  ${r}`).join('\n'),
    ).toEqual([]);
  });
});
