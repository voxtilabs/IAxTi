import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Crear una secuencia de seguimiento (#480).
 *
 * `POST /automations/sequences` existe desde #63 y no la llamaba nadie: la
 * bandeja deja METER una conversación a una secuencia y no había forma de
 * crear ninguna, así que el selector de la ficha estaba siempre vacío.
 */
const AUTO = readFileSync(join(__dirname, '..', 'components', 'automatizaciones.tsx'), 'utf8');

describe('crear una secuencia', () => {
  it('llama a la ruta que ya existía', () => {
    expect(AUTO).toContain("await llamar('/automations/sequences', {");
  });

  it('las horas se cuentan desde el paso anterior', () => {
    // Es lo que espera el dominio; contarlas desde el inicio dispararía
    // todos los pasos casi juntos.
    expect(AUTO).toContain('afterHours: Number(p.horas)');
    expect(AUTO).toContain('Después del anterior, esperar');
  });

  it('cada paso puede cortarse si el cliente respondió', () => {
    expect(AUTO).toContain('onlyIfNoReply: p.soloSinRespuesta');
  });

  it('el último paso no se puede quitar', () => {
    // Una secuencia sin pasos la rechaza el dominio; dejar quitar el
    // último solo regala un error.
    expect(AUTO).toContain('secuencia.pasos.length > 1');
  });

  it('si el dominio la rechaza, lo escrito no se borra', () => {
    expect(AUTO).toContain('if (creada) {');
  });
});
