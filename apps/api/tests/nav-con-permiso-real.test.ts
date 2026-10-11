import { describe, expect, it } from 'vitest';
import { findModulesDir, loadAllManifests } from '@iaxti/core';
import { registry } from '../src/registry';

/**
 * Cada entrada del menú declara un permiso que EXISTE (#814).
 *
 * Desde que el menú se filtra por el permiso de cada entrada, un permiso mal
 * escrito en un `module.yaml` ya no es cosmético: esconde ese destino para
 * TODOS, incluido el ADMIN, y sin un error en ninguna parte. La persona no ve
 * la pantalla y nadie se entera de por qué.
 *
 * Antes de #814 el campo no lo leía nadie, así que un `audit.raed` habría
 * vivido ahí para siempre sin consecuencia. Ahora la tiene, y por eso la
 * guarda: el precio de que el campo por fin importe es comprobarlo.
 */
describe('el permiso de cada entrada del menú existe en el catálogo', () => {
  const catalogo = new Set(registry.permissionsCatalog().keys());
  const entradas = loadAllManifests(findModulesDir()).flatMap((m) =>
    (m.nav ?? []).map((item) => ({
      modulo: m.module.id,
      label: item.label,
      path: item.path,
      permission: item.permission,
    })),
  );

  it('la guarda está mirando algo: hay entradas y hay catálogo', () => {
    // Anti-vacuidad. Sin esto, un `loadAllManifests` que devuelva nada deja
    // la aserción de abajo en verde sobre una lista vacía.
    expect(entradas.length).toBeGreaterThan(20);
    expect(catalogo.size).toBeGreaterThan(50);
  });

  it('ninguna entrada apunta a un permiso que no existe', () => {
    const fantasmas = entradas
      .filter((e) => !catalogo.has(e.permission))
      .map((e) => `${e.modulo}: "${e.label}" (${e.path}) pide ${e.permission}`);
    expect(
      fantasmas,
      'Entradas del menú con un permiso que no está en el catálogo. Desde #814 el menú se ' +
        'filtra por este campo, así que esto esconde el destino para TODOS:\n  ' +
        fantasmas.join('\n  '),
    ).toEqual([]);
  });

  it('toda entrada declara su permiso: ninguna en blanco', () => {
    const sinPermiso = entradas
      .filter((e) => !e.permission || e.permission.trim() === '')
      .map((e) => `${e.modulo}: "${e.label}"`);
    expect(sinPermiso).toEqual([]);
  });
});
