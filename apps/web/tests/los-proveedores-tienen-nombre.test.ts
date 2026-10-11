import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cada proveedor elegible tiene su nombre legible en la pantalla (#842).
 *
 * `PROVIDERS` es un array en `agents/domain/config.ts` y los nombres que ve
 * una persona viven en `ajustes-de-ia.tsx`. Agregar un proveedor es una línea
 * en el array, y la pantalla está en otro archivo: el desplegable mostraría el
 * id crudo —`openai`— en vez de un nombre, o nada.
 *
 * Es el mismo cruce que ya cuida `compliance-proveedores.test.ts` para la
 * matriz de compliance, con los mismos dos archivos lejos uno del otro.
 */
const RAIZ = join(__dirname, '..', '..', '..');

function proveedores(): string[] {
  const config = readFileSync(
    join(RAIZ, 'packages/modules/agents/domain/config.ts'),
    'utf8',
  );
  const m = /export const PROVIDERS = \[([^\]]+)\]/.exec(config);
  expect(m, 'no se encontró `export const PROVIDERS` en config.ts').toBeTruthy();
  return [...m![1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
}

describe('los proveedores de IA tienen nombre en la pantalla', () => {
  const PANTALLA = readFileSync(
    join(RAIZ, 'apps/web/components/ajustes-de-ia.tsx'),
    'utf8',
  );

  it('la guarda está mirando algo: hay proveedores declarados', () => {
    // Anti-vacuidad: con un array vacío el `for` de abajo no correría y esto
    // quedaría verde sin comprobar nada.
    expect(proveedores().length).toBeGreaterThanOrEqual(3);
  });

  it('ninguno se mostraría con su id crudo', () => {
    const sinNombre = proveedores().filter(
      (p) => !new RegExp(`^\\s*${p}: '`, 'm').test(PANTALLA),
    );
    expect(
      sinNombre,
      'Estos proveedores son elegibles y el desplegable de Ajustes → IA no les tiene nombre, ' +
        `así que mostraría el id: ${sinNombre.join(', ')}`,
    ).toEqual([]);
  });
});
