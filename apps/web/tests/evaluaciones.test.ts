import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Si el asistente mejoró o empeoró (#53, #447).
 *
 * El dataset y el juez existen desde #53, con un gate que impide pasar a
 * una configuración que rinde peor. Corría y no lo veía nadie: cambiar de
 * modelo o de prompt era a ciegas, y el gate bloqueaba sin que se pudiera
 * saber por qué.
 */
const PANEL = readFileSync(join(__dirname, '..', 'components', 'evaluaciones.tsx'), 'utf8');
const PAGINA = readFileSync(join(__dirname, '..', 'app', 'ajustes', 'ia', 'page.tsx'), 'utf8');

describe('las evaluaciones del asistente', () => {
  it('viven donde se cambia el asistente', () => {
    expect(PAGINA).toContain('Evaluaciones');
  });

  it('muestra la COMPARACIÓN, no un número suelto', () => {
    // «0,82» no dice nada; «0,82 con Flash, antes 0,79 con Pro» decide.
    expect(PANEL).toMatch(/Diferencia/);
    expect(PANEL).toMatch(/corrida\.score - previa\.score/);
    expect(PANEL).toMatch(/\{c\.provider\}\/\s*\n?\s*\{c\.model\}|c\.provider\}\/\{c\.model/);
  });

  it('avisa cuando la medición NO es de la configuración vigente', () => {
    // Un puntaje sacado con otro modelo no dice nada del asistente que
    // está atendiendo ahora.
    expect(PANEL).toMatch(/configuracionActual/);
    expect(PANEL).toContain('Medida con otra configuración');
  });

  it('distingue los casos MEDIDOS de los casos totales', () => {
    // Un juez cortado no es un cero: contarlo como tal mezcla «respondió
    // pésimo» con «no se pudo medir», y de ese promedio depende el gate.
    expect(PANEL).toMatch(/casesMedidos.*caseCount|casesMedidos\} de \{/s);
  });

  it('sin mediciones explica de dónde salen los casos', () => {
    // El dataset se llena solo con el pulgar de la bandeja; sin decirlo,
    // el estado vacío parece una función que no funciona.
    expect(PANEL).toContain('pulgar arriba/abajo de la bandeja');
  });
});
