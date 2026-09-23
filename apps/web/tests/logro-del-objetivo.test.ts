import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Si el asistente está logrando su objetivo (#460).
 *
 * `GET /agents/:id/objetivo` existe desde #319 y no la llamaba nadie. Cada
 * conversación deja un intento con su desenlace y su ATRIBUCIÓN —lo logró
 * él, ayudó, o lo terminó una persona—, y todo eso se medía sin que nadie
 * pudiera verlo.
 */
const LOGRO = readFileSync(join(__dirname, '..', 'components', 'logro-del-objetivo.tsx'), 'utf8');
const PAGINA = readFileSync(join(__dirname, '..', 'app', 'ajustes', 'ia', 'page.tsx'), 'utf8');

describe('logro del objetivo', () => {
  it('llama a la ruta que ya medía', () => {
    expect(LOGRO).toContain('`/agents/${primero.id}/objetivo`');
  });

  it('va antes de «¿mejoró o empeoró?»', () => {
    // Primero si sirve para lo suyo; después si la última configuración lo
    // hizo mejor o peor.
    expect(PAGINA.indexOf('<LogroDelObjetivo />')).toBeLessThan(PAGINA.indexOf('<Evaluaciones />'));
  });

  it('sin conversaciones terminadas no muestra un 0%', () => {
    // "Todavía no se sabe" y "le va pésimo" se ven igual si se redondea.
    expect(LOGRO).toContain('tasa.cerrados === 0');
    expect(LOGRO).toContain('Todavía ninguna terminó');
  });

  it('muestra las DOS tasas, no una', () => {
    // «45% él, 72% con ayuda» dice que sirve pero no solo; «70% y 71%»
    // dice que el equipo casi no está interviniendo.
    expect(LOGRO).toContain('tasa.tasaDelAgente');
    expect(LOGRO).toContain('tasa.tasaConAsistencia');
  });

  it('sin objetivo medido, la sección no aparece', () => {
    expect(LOGRO).toContain('tasa.objetivo === null) return null');
  });
});
