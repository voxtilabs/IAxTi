import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '../src/testing';

/**
 * La llave de un canal se lee en UN lugar (#1393).
 *
 * Eran cuatro `process.env[cuenta.credentialRef]`: el envío, el diagnóstico,
 * las plantillas y la descarga de adjuntos. Desde que la llave puede vivir en
 * la custodia cifrada (ADR-0038), una quinta copia así deja a las cuentas
 * conectadas desde la app sin llave en ESE camino, y el síntoma —un adjunto
 * que no baja, un diagnóstico en rojo— no apunta a la causa.
 *
 * El camino es `credencialDeLaCuenta` de `@iaxti/module-whatsapp`, que
 * entiende las dos formas de referencia. Los pagos tienen su propio
 * `credential_ref` (otra tabla, otra decisión) y quedan fuera.
 */
const RAIZ = join(__dirname, '../../..');
const PERMITIDO = new Set(['packages/modules/whatsapp/application/webhook-secret.ts']);

function* fuentes(dir: string): Generator<string> {
  for (const entrada of readdirSync(dir)) {
    if (['node_modules', 'dist', 'tests', '.next', '.turbo', 'payments'].includes(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) yield* fuentes(ruta);
    else if (/\.tsx?$/.test(entrada) && !/payments/.test(entrada)) yield ruta;
  }
}

describe('la llave del canal se lee en un solo lugar', () => {
  it('nadie lee `credentialRef` directo de process.env salvo el resolvedor', () => {
    const culpables: string[] = [];
    for (const dir of ['packages/modules', 'apps']) {
      for (const ruta of fuentes(join(RAIZ, dir))) {
        const relativa = ruta.slice(RAIZ.length + 1);
        if (PERMITIDO.has(relativa)) continue;
        const limpio = fuenteLimpia(readFileSync(ruta, 'utf8'));
        if (/process\.env\[[^\]]*credentialRef/.test(limpio)) culpables.push(relativa);
      }
    }
    expect(
      culpables,
      'Usá `credencialDeLaCuenta` de `@iaxti/module-whatsapp`: entiende la variable de entorno ' +
        'Y la custodia cifrada (ADR-0038). Leer el entorno a secas deja muda a la cuenta conectada desde la app.',
    ).toEqual([]);
  });
});
