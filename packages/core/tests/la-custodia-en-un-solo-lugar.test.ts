import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '../src/testing';

/**
 * Dónde se guarda un secreto se decide en UN lugar (#1175).
 *
 * Había dos y no coincidían. El calendario elegía el disco cifrado cuando el
 * entorno lo pedía —que es lo que manda ADR-0028 para la v1— y whatsapp
 * llamaba derecho a `createGoogleSecretStore`. Consecuencia: conectar un
 * WhatsApp exigía un proyecto de Google Cloud, y como la custodia se
 * construye ANTES de la primera llamada al proveedor, el botón «Conectar
 * WhatsApp» devolvía 503 sin llegar a hablar con Zavu. Desde afuera parecía
 * un problema de Zavu, que no tiene nada que ver con Google Cloud.
 *
 * A la tercera copia, una de las tres queda vieja, y el síntoma —creer que
 * se guarda en Secret Manager y estar escribiendo en un disco efímero— no se
 * descubre hasta que hace falta leer el secreto.
 */
const RAIZ = join(__dirname, '../../..');

function* fuentes(dir: string): Generator<string> {
  for (const entrada of readdirSync(dir)) {
    if (['node_modules', 'dist', 'tests', '.next', '.turbo'].includes(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) yield* fuentes(ruta);
    else if (/\.tsx?$/.test(entrada)) yield ruta;
  }
}

describe('la custodia de secretos se elige en un solo lugar', () => {
  it('nadie INVOCA createGoogleSecretStore salvo el selector de @iaxti/google', () => {
    const culpables: string[] = [];
    for (const dir of ['packages/modules', 'apps']) {
      for (const ruta of fuentes(join(RAIZ, dir))) {
        // Se escanea LIMPIO (#569): un comentario que explique esto —como el
        // de `partner-provider.ts`— no puede poner la guarda roja.
        const limpio = fuenteLimpia(readFileSync(ruta, 'utf8'));
        // Pasarlo como ARGUMENTO está bien: así se le inyecta el creador al
        // selector. Lo que no puede es invocarse.
        if (/createGoogleSecretStore\s*\(/.test(limpio)) culpables.push(ruta.slice(RAIZ.length + 1));
      }
    }
    expect(
      culpables,
      'Usá `custodiaDesdeEntorno(createGoogleSecretStore)` de `@iaxti/google`. ' +
        'Una segunda copia de esta decisión es cómo se llega a que un módulo ' +
        'guarde en Secret Manager y otro en disco (ADR-0028).',
    ).toEqual([]);
  });
});
