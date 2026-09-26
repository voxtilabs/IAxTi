import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ModuleRegistry, CORE_MODULES } from '../src/registry';
import { loadAllManifests } from '../src/manifest';

/**
 * Los directorios temporales se borran al terminar.
 *
 * Sin esto cada corrida deja uno —esta prueba, varios— y el tmpfs se llena: llegué
 * a 2168 directorios `iaxti-*` y más de 600 MB, y lo que rompió no fue una prueba
 * sino la máquina, a mitad de otra cosa. Una prueba que deja basura es una prueba
 * que a la larga hace fallar a las demás, y el fallo aparece lejísimos de acá.
 */
const temporales: string[] = [];
function registrarTemporal(dir: string): string {
  temporales.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});


// Test de combinación (SPEC §26 regla 9): cada módulo arranca solo con sus
// required transitivos, y la app arranca con todo apagado menos el núcleo.
// Es genérico: cada módulo nuevo que llegue queda cubierto automáticamente.

const REAL_MODULES = resolve(__dirname, '../../modules');

function transitiveRequired(id: string, deps: Map<string, string[]>): Set<string> {
  const closure = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    for (const dep of deps.get(stack.pop() as string) ?? []) {
      if (!closure.has(dep)) {
        closure.add(dep);
        stack.push(dep);
      }
    }
  }
  return closure;
}

function fixtureWith(ids: Set<string>): string {
  const dir = registrarTemporal(mkdtempSync(join(tmpdir(), 'iaxti-comb-')));
  for (const id of ids) {
    cpSync(join(REAL_MODULES, id), join(dir, id), { recursive: true });
  }
  return dir;
}

describe('combinaciones de módulos', () => {
  const manifests = loadAllManifests(REAL_MODULES);
  const deps = new Map(
    manifests.map((m) => [m.module.id, m.depends_on?.required ?? []]),
  );

  it.each(manifests.map((m) => [m.module.id]))(
    'el módulo "%s" arranca solo con sus required transitivos',
    (id) => {
      const closure = transitiveRequired(id, deps);
      // El núcleo declara core: true y el registry lo exige completo: los
      // cuatro del núcleo siempre acompañan (nunca se apagan, SPEC regla 8).
      for (const core of CORE_MODULES) closure.add(core);
      const registry = new ModuleRegistry(fixtureWith(closure)).load();
      expect(registry.isActive(id)).toBe(true);
      expect(registry.health().every((m) => m.active)).toBe(true);
    },
  );

  it('la app arranca con todo apagado menos el núcleo', () => {
    const registry = new ModuleRegistry(REAL_MODULES).load();
    const apagables = registry
      .initOrder()
      .filter((id) => !(CORE_MODULES as readonly string[]).includes(id))
      .reverse(); // dependientes primero, para que la regla 4 no bloquee

    for (const id of apagables) registry.disable(id);

    const health = registry.health();
    for (const m of health) {
      if ((CORE_MODULES as readonly string[]).includes(m.id)) {
        expect(m.active).toBe(true);
      } else {
        expect(m.active).toBe(false);
      }
    }
  });
});
