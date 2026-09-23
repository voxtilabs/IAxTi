import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Los horarios en que atiendo (#460).
 *
 * `POST /agenda/disponibilidad` existe desde #57 y no la llamaba nadie: la
 * agenda ofrecía huecos con lo que hubiera quedado sembrado, y el
 * asistente ofrecía esas mismas horas por `calendar.get_slots`. Quien
 * atiende los sábados por la mañana no tenía cómo decirlo.
 */
const HORARIOS = readFileSync(join(__dirname, '..', 'components', 'horarios-de-atencion.tsx'), 'utf8');
const AGENDA = readFileSync(join(__dirname, '..', 'components', 'agenda.tsx'), 'utf8');

describe('horarios de atención', () => {
  it('vive en la agenda, después de las horas del día', () => {
    // Quien abre la agenda viene a ver qué tiene hoy, no a configurar.
    const i = AGENDA.indexOf('<HorariosDeAtencion />');
    expect(i).toBeGreaterThan(0);
    expect(AGENDA.slice(0, i)).toContain('EncabezadoDePagina');
  });

  it('se agregan, se listan y se quitan', () => {
    expect(HORARIOS).toContain("'/agenda/disponibilidad'");
    expect(HORARIOS).toContain('`/agenda/disponibilidad/${f.id}`');
    expect(HORARIOS).toContain("method: 'DELETE'");
  });

  it('dice que quitar un horario no cancela las citas tomadas', () => {
    // Si no, alguien limpia sus horarios creyendo que se cancela lo que
    // ya estaba, y el cliente igual llega.
    expect(HORARIOS).toContain('no cancela las citas');
  });

  it('el choque entre franjas lo rechaza el servidor', () => {
    expect(HORARIOS).toContain('setAviso((err as Error).message)');
  });
});
