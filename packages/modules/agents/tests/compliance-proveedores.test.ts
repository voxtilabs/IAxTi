import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDERS } from '../domain/config';

/**
 * Cada proveedor de IA elegible tiene su fila de transferencia internacional
 * (#81, Ley 21.719 · ISO 27701 7.5).
 *
 * `anthropic` estaba en `PROVIDERS` desde siempre —cualquier tenant lo podía
 * poner como proveedor de una tarea— y **no tenía fila** en la matriz de
 * compliance. Gemini, Zavu, Supabase y R2 sí. El texto de las conversaciones
 * sale hacia el proveedor elegido igual en los cuatro casos.
 *
 * Nadie lo notó porque agregar un proveedor es una línea en un array y la
 * matriz vive en otro archivo. Esto los mira a los dos.
 */
const MATRIZ = join(__dirname, '../../../../docs/COMPLIANCE_BASELINE.md');

/** Cómo se llama cada proveedor en la matriz, que está escrita para leerse. */
const NOMBRE_EN_LA_MATRIZ: Record<string, string> = {
  google: 'Google Gemini',
  anthropic: 'Anthropic',
  glm: 'GLM',
};

describe('la matriz de compliance y los proveedores de IA', () => {
  it('todo proveedor elegible tiene su fila de transferencia internacional', () => {
    const texto = readFileSync(MATRIZ, 'utf8');
    for (const proveedor of PROVIDERS) {
      const nombre = NOMBRE_EN_LA_MATRIZ[proveedor];
      expect(nombre, `falta el nombre legible de "${proveedor}" en este test`).toBeTruthy();
      const fila = new RegExp(`\\| Transferencia internacional · ${nombre}[^|]*\\|`);
      expect(
        texto,
        `"${proveedor}" es elegible y no tiene fila de transferencia internacional en COMPLIANCE_BASELINE.md`,
      ).toMatch(fila);
    }
  });

  it('ninguna fila afirma cumplimiento ISO', () => {
    const texto = readFileSync(MATRIZ, 'utf8');
    // SPEC §30: la arquitectura es auditable; la certificación es otra cosa.
    // Un "cumple ISO" en este documento es lo que después aparece en una
    // presentación comercial.
    const filas = texto.split('\n').filter((l) => l.startsWith('|'));
    for (const fila of filas) {
      expect(fila.toLowerCase(), `una fila afirma cumplimiento: ${fila.slice(0, 60)}`).not.toMatch(
        /cumple (con )?(la )?iso|certificad[oa] iso|iso[- ]?\d+ certificad/,
      );
    }
  });
});
