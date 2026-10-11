import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findModulesDir, loadAllManifests } from '@iaxti/core';
import { REPETIBLES } from '../src/repetibles';

/**
 * Todo job encolado declara un `moduleId`, y el worker SALTA el job si ese
 * módulo no está activo. Un id que no existe —'core', un typo, un módulo
 * renombrado— no falla: el job simplemente no corre nunca, en silencio.
 *
 * Me pasó escribiendo el barrido de idempotencia: puse `moduleId: 'core'`,
 * que no es un módulo, y el barrido no habría corrido jamás.
 */
describe('los jobs apuntan a módulos que existen', () => {
  it('cada moduleId de los jobs es un módulo del registro', () => {
    const fuente = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
    const usados = [
      // Los repetibles vienen de la lista tipada y no de un regex sobre el
      // texto: desde #807 están declarados en `repetibles.ts`, y un escáner
      // de texto que apunta al archivo equivocado no encuentra nada y se
      // queda verde.
      ...REPETIBLES.map((r) => r.moduleId),
      ...[...fuente.matchAll(/moduleId:\s*'([a-z_]+)'/g)].map((m) => m[1]),
    ];
    expect(usados.length).toBeGreaterThan(5); // que siga encontrando algo

    const conocidos = new Set(loadAllManifests(findModulesDir()).map((m) => m.module.id));
    const fantasmas = [...new Set(usados)].filter((id) => !conocidos.has(id));
    expect(fantasmas, `módulos inexistentes en jobs: ${fantasmas.join(', ')}`).toEqual([]);
  });
});
