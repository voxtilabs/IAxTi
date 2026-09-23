import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Crear una regla propia (#480).
 *
 * `POST /automations` existe desde #62 y no la llamaba nadie: el negocio
 * se quedaba con las tres reglas de su rubro o con ninguna. El guard no lo
 * veía porque el `GET` de la misma ruta sí tiene pantalla.
 */
const AUTO = readFileSync(join(__dirname, '..', 'components', 'automatizaciones.tsx'), 'utf8');

describe('crear una regla', () => {
  it('llama a la ruta que ya existía', () => {
    expect(AUTO).toContain("await llamar('/automations', {");
    expect(AUTO).toContain("method: 'POST'");
  });

  it('el disparador es por evento o por tiempo, como el dominio', () => {
    expect(AUTO).toContain("nueva.tipo === 'event'");
    expect(AUTO).toContain("kind: 'time'");
  });

  it('la etapa solo viaja cuando el tiempo se cuenta en una etapa', () => {
    expect(AUTO).toContain("nueva.base === 'in_stage' ? { stageName: nueva.etapa } : {}");
  });

  it('si el dominio la rechaza, lo escrito no se borra', () => {
    // Volver a escribir todo por un nombre repetido es la forma más
    // rápida de que alguien deje de intentarlo.
    expect(AUTO).toContain('if (creada) setNueva(');
  });

  it('dice que el mensaje al cliente igual respeta las reglas de siempre', () => {
    // El servidor lo aplica igual; enterarse al guardar es tarde.
    expect(AUTO).toContain('consentimiento y horario de silencio');
  });

  it('nace apagada, y el texto del botón lo dice', () => {
    expect(AUTO).toContain('nace apagada');
  });
});
