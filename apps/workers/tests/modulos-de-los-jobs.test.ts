import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findModulesDir, loadAllManifests } from '@iaxti/core';

/**
 * Todo job encolado declara un `moduleId`, y el worker SALTA el job si ese
 * módulo no está activo. Un id que no existe —'core', un typo, un módulo
 * renombrado— no falla: el job simplemente no corre nunca, en silencio.
 *
 * Me pasó escribiendo el barrido de idempotencia: puse `moduleId: 'core'`,
 * que no es un módulo, y el barrido no habría corrido jamás.
 */
describe('los jobs apuntan a módulos que existen', () => {
  it('cada moduleId de main.ts es un módulo del registro', () => {
    const fuente = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
    const usados = [...fuente.matchAll(/moduleId:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(usados.length).toBeGreaterThan(5); // que el regex siga encontrando algo

    const conocidos = new Set(loadAllManifests(findModulesDir()).map((m) => m.module.id));
    const fantasmas = [...new Set(usados)].filter((id) => !conocidos.has(id));
    expect(fantasmas, `módulos inexistentes en jobs: ${fantasmas.join(', ')}`).toEqual([]);
  });
});
