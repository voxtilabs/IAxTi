import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El prefijo `/v1` lo pone `setGlobalPrefix`, no cada controller.
 *
 * `empresas.controller.ts` declaraba `@Controller('v1/empresas')` y sus
 * rutas terminaban en `/v1/v1/empresas`. O sea que `/v1/empresas` —la que
 * documenta el OpenAPI, la que genera el SDK, la que cualquiera escribiría—
 * devolvía 404. El módulo entero vivía en una dirección que nadie iba a
 * usar, y nada lo decía: el controller se registra igual, las rutas existen
 * igual, y los tests que lo probaban usaban la ruta equivocada.
 *
 * Lo mismo pasaba con su segundo controller, que declaraba `v1/contacts` y
 * convivía sin ruido con el de contactos de verdad.
 */
const DIR = join(__dirname, '..', 'src');

describe('las rutas no repiten el prefijo', () => {
  const controllers = readdirSync(DIR).filter((f) => f.endsWith('.controller.ts'));

  it('hay controllers que mirar', () => {
    expect(controllers.length).toBeGreaterThanOrEqual(20);
  });

  it("ningún @Controller empieza con 'v1/'", () => {
    const malos: string[] = [];
    for (const f of controllers) {
      const s = readFileSync(join(DIR, f), 'utf8');
      for (const m of s.matchAll(/@Controller\(\s*'([^']*)'/g)) {
        if (/^v1\//.test(m[1])) malos.push(`${f}: @Controller('${m[1]}')`);
      }
    }
    expect(
      malos,
      'Estos controllers repiten el prefijo que ya pone setGlobalPrefix:\n' +
        malos.map((x) => `  ${x}`).join('\n') +
        '\nSus rutas quedan en /v1/v1/… y la dirección documentada devuelve 404.',
    ).toEqual([]);
  });

  it('y el prefijo global sigue siendo v1', () => {
    // Si alguien lo cambia, esta guarda deja de tener sentido y hay que
    // mirarla de nuevo en vez de dejarla comprobando algo que ya no aplica.
    const main = readFileSync(join(DIR, 'main.ts'), 'utf8');
    expect(main).toContain("setGlobalPrefix('v1'");
  });
});
