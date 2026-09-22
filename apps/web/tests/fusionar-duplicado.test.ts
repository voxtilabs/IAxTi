import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fusionar el duplicado de una persona (#447).
 *
 * `mergeContacts` existe desde #34 —mueve oportunidades, actividades y
 * etiquetas, deja el duplicado apuntando al principal y publica el evento
 * que reapunta las conversaciones— y su ruta no la llamaba nadie. Pasa todo
 * el tiempo: la misma persona escribe por WhatsApp y después por el chat
 * del sitio, o cambia de número.
 *
 * Como la fusión NO se deshace, lo que se cuida acá es que se vea qué se va
 * a mover ANTES de tocar el botón.
 */
const PANEL = readFileSync(join(__dirname, '..', 'components', 'crm', 'fusionar-duplicado.tsx'), 'utf8');
const FICHA = readFileSync(join(__dirname, '..', 'components', 'crm', 'ficha-contacto.tsx'), 'utf8');

describe('fusionar un duplicado', () => {
  it('está en la ficha, y no en el panel de la bandeja', () => {
    expect(FICHA).toMatch(/!compacta && \(\s*<FusionarDuplicado/);
  });

  it('avisa que no se deshace, antes de fusionar', () => {
    expect(PANEL).toContain('No se puede deshacer');
    expect(PANEL).toMatch(/variant="destructivo"/);
  });

  it('muestra QUÉ trae el duplicado antes de apretar', () => {
    // Sin esto, arreglar un duplicado puede ser peor que el duplicado:
    // nadie sabe cuántas oportunidades se está moviendo.
    expect(PANEL).toMatch(/queTrae/);
    expect(PANEL).toMatch(/ficha\.deals\.length/);
    expect(PANEL).toMatch(/ficha\.activities\.length/);
  });

  it('no se ofrece a sí mismo como duplicado', () => {
    expect(PANEL).toMatch(/filter\(\(c\) => c\.id !== contactId\)/);
  });

  it('no necesitó una ruta nueva para poder mirar antes de saltar', () => {
    // La ficha del duplicado ya tenía lo que hace falta. Una ruta nueva
    // para una vista previa habría sido superficie de API sin necesidad.
    expect(PANEL).toMatch(/\/contacts\/\$\{c\.id\}/);
    expect(PANEL).not.toMatch(/merge\/preview|preview-merge/);
  });

  it('después de fusionar recarga la ficha', () => {
    expect(PANEL).toContain('onFusionado');
    expect(FICHA).toMatch(/onFusionado=\{cargar\}/);
  });
});
