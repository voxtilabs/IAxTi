import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #507: las pruebas también pasan por el compilador.
 *
 * Estaban todas afuera, y por una razón real: `build` y `typecheck` compartían
 * el `tsconfig.json`, así que meter `tests` en el `include` hacía que el build
 * las emitiera dentro de `dist/`. La salida fue separar las dos tareas — un
 * `tsconfig.typecheck.json` por paquete— y no abrir el include del build.
 *
 * Lo que vigila esta guarda es que un paquete nuevo no nazca con sus pruebas
 * afuera. No falla nada cuando eso pasa: el paquete compila, CI queda verde, y
 * sus pruebas pueden llamar a una función con la firma equivocada y pasar por
 * la razón equivocada. Fue exactamente lo que encontramos al prender esto:
 * una prueba de permisos que pasaba porque la herramienta no existía, un
 * `optOut` sin motivo, un link de pago sin quién lo emitió, y un job armado
 * sin la bandera que el producto volvió obligatoria para que una automatización
 * no saliera a las 3 de la mañana.
 */
const RAIZ = join(__dirname, '..', '..', '..');

function paquetes(): string[] {
  const salida: string[] = [];
  for (const base of ['apps', 'packages', join('packages', 'modules')]) {
    const dir = join(RAIZ, base);
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (!statSync(p).isDirectory() || entry === 'modules' || entry === 'node_modules') continue;
      try {
        statSync(join(p, 'tsconfig.json'));
        salida.push(p);
      } catch {
        // Sin tsconfig no hay nada que chequear.
      }
    }
  }
  return salida;
}

function tieneTests(dir: string): boolean {
  try {
    return readdirSync(join(dir, 'tests')).some((f) => /\.test\.(ts|tsx|mjs)$/.test(f));
  } catch {
    return false;
  }
}

/** Lo que el script `typecheck` le pasa a `tsc`, y el `include` de ese proyecto. */
function comoSeChequea(dir: string): { proyecto: string; include: string[] | null } {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const script = pkg.scripts?.typecheck ?? '';
  const m = /-p\s+(\S+)/.exec(script);
  const proyecto = m?.[1] ?? 'tsconfig.json';
  const crudo = readFileSync(join(dir, proyecto), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const conf = JSON.parse(crudo) as { include?: string[] };
  return { proyecto, include: conf.include ?? null };
}

describe('las pruebas también se chequean (#507)', () => {
  const conPruebas = paquetes().filter(tieneTests);

  it('el escáner encuentra los paquetes (si esto falla, el escáner se rompió)', () => {
    expect(conPruebas.length).toBeGreaterThan(25);
  });

  it('el typecheck de cada paquete alcanza su carpeta tests', () => {
    const afuera: string[] = [];
    for (const dir of conPruebas) {
      const { proyecto, include } = comoSeChequea(dir);
      // Sin `include` se toma todo, así que las pruebas entran.
      const alcanza =
        include === null || include.some((x) => x.includes('test') || x.includes('*'));
      if (!alcanza) afuera.push(`${dir.replace(`${RAIZ}/`, '')} (${proyecto}: ${include.join(', ')})`);
    }
    expect(
      afuera,
      'Estos paquetes corren pruebas que el compilador no mira. Agrega un ' +
        'tsconfig.typecheck.json que extienda el de build y sume "tests", y ' +
        'apunta el script typecheck ahí:\n  ' + afuera.join('\n  '),
    ).toEqual([]);
  });

  it('el tsconfig del BUILD sigue sin las pruebas: no se emiten a dist', () => {
    // La otra mitad del trato. Si alguien "simplifica" metiendo tests en el
    // include del build, el paquete publicado se lleva las pruebas adentro.
    const contaminados: string[] = [];
    for (const dir of conPruebas) {
      const crudo = readFileSync(join(dir, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      const conf = JSON.parse(crudo) as { include?: string[] };
      if (conf.include?.some((x) => x.includes('test'))) {
        contaminados.push(dir.replace(`${RAIZ}/`, ''));
      }
    }
    expect(contaminados, 'El tsconfig de build no puede incluir las pruebas').toEqual([]);
  });
});
