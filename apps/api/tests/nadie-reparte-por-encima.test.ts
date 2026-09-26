import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANDAN } from '../src/authz/no-por-encima';
import { registry } from '../src/registry';

/**
 * Guarda: toda ruta que reparta o edite permisos de rol pasa por la regla (#567).
 *
 * #556 cerró una de cuatro puertas al mismo sitio y yo anuncié la garantía como
 * si estuvieran las cuatro. La quinta se abre sola si nadie la vigila: basta un
 * `@Post` nuevo en este controller que toque roles y la escalada vuelve, sin que
 * nada falle y sin que nadie lo note.
 */

const RAIZ = join(__dirname, '..', 'src');
const ROLES = readFileSync(join(RAIZ, 'roles.controller.ts'), 'utf8');
const EQUIPO = readFileSync(join(RAIZ, 'equipo-usuarios.controller.ts'), 'utf8');

const sinComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * Los métodos que otorgan o cambian lo que un rol puede hacer. Si agregas uno,
 * o lo pones acá o la guarda te lo pide: no hay tercera opción escrita.
 */
const REPARTEN = ['create', 'update', 'assign'] as const;

describe('nadie reparte por encima de sí mismo (#567)', () => {
  it('las tres rutas de roles pasan por la comprobación', () => {
    const limpio = sinComentarios(ROLES);
    for (const metodo of REPARTEN) {
      const i = limpio.indexOf(`async ${metodo}(`);
      expect(i, `no encontré el método ${metodo}`).toBeGreaterThan(0);
      // El siguiente método marca el final del bloque de este.
      const siguientes = REPARTEN.map((m) => limpio.indexOf(`async ${m}(`, i + 1)).filter((j) => j > 0);
      const fin = siguientes.length > 0 ? Math.min(...siguientes) : limpio.length;
      expect(
        limpio.slice(i, fin),
        `${metodo} otorga o edita permisos de rol y no pasa por nadiePorEncimaDeSiMismo`,
      ).toContain('nadiePorEncimaDeSiMismo');
    }
  });

  it('la invitación usa la MISMA regla, no una copia', () => {
    expect(EQUIPO).toContain('nadiePorEncimaDeSiMismo');
    // Y ya no tiene su propia versión: cuatro copias de una regla de
    // autorización se separan, y la vieja es la que alguien va a usar.
    const limpio = sinComentarios(EQUIPO);
    expect(limpio).not.toContain('MANDAN.has(');
    expect(limpio).not.toMatch(/const MANDAN|export const MANDAN/);
  });

  it('no aparece ninguna ruta nueva de roles sin la comprobación', () => {
    const limpio = sinComentarios(ROLES);
    // Los métodos del controller que responden a un verbo que escribe.
    const escriben = [...limpio.matchAll(/@(?:Post|Put|Patch|Delete)\([^)]*\)[\s\S]{0,400}?async (\w+)\(/g)]
      .map((m) => m[1]!);
    expect(escriben.length, 'el escáner tiene que encontrar rutas').toBeGreaterThan(0);
    const sinRegla = escriben.filter((m) => !REPARTEN.includes(m as (typeof REPARTEN)[number]));
    expect(
      sinRegla,
      'Ruta nueva que escribe en roles. Si reparte o edita permisos, pasa por ' +
        'nadiePorEncimaDeSiMismo y agrégala a REPARTEN; si no, agrégala acá con su motivo.',
    ).toEqual([]);
  });

  it('todo permiso que reparte poder o toca plata está decidido', () => {
    // Una lista curada se muere sola. Si un `module.yaml` trae un permiso nuevo
    // de estas familias, alguien tiene que decir si manda o no.
    const FAMILIAS = /^(roles|users|tenant|apikeys|webhooks)\.|^payments\.manage|^agents\.configure|^channels\.manage/;
    /** Los de lectura no reparten nada: leer quién es quién no es poder. */
    const NO_MANDAN_POR_ESCRITO: Record<string, string> = {
      'roles.read': 'Leer el catálogo de roles no reparte nada.',
      'users.read': 'Ver quién está en el equipo no reparte nada.',
      'tenant.read': 'Leer los datos del negocio no reparte nada.',
    };
    const sinDecidir = [...registry.permissionsCatalog().keys()]
      .filter((p) => FAMILIAS.test(p))
      .filter((p) => !MANDAN.has(p) && NO_MANDAN_POR_ESCRITO[p] === undefined);
    expect(
      sinDecidir,
      'Permisos nuevos de las familias que reparten poder. Decide: o van en MANDAN, ' +
        'o en NO_MANDAN_POR_ESCRITO con el motivo.',
    ).toEqual([]);
  });

  it('MANDAN solo contiene permisos que existen de verdad', () => {
    // Un permiso renombrado en un `module.yaml` dejaría en MANDAN un string que
    // nadie tiene, y la regla se relajaría en silencio.
    const catalogo = new Set(registry.permissionsCatalog().keys());
    expect([...MANDAN].filter((p) => !catalogo.has(p))).toEqual([]);
  });
});
