import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Corregir los datos de un contacto (#480).
 *
 * `PATCH /contacts/:id` existe desde #34 y no la llamaba nadie: un nombre
 * mal escrito, un correo o un RUT solo se arreglaban volviendo a importar
 * la planilla, y los campos propios del negocio solo se podían llenar en
 * esa importación. La ficha lo mostraba todo y no dejaba tocar nada.
 *
 * El guard de rutas no lo veía porque miraba solo la ruta: `GET /contacts`
 * existe, así que `PATCH /contacts/:id` parecía consumido.
 */
const FICHA = readFileSync(join(__dirname, '..', 'components', 'crm', 'ficha-contacto.tsx'), 'utf8');

describe('corregir un contacto', () => {
  it('se corrige desde la ficha', () => {
    expect(FICHA).toContain('`/contacts/${contactId}`');
    expect(FICHA).toContain("method: 'PATCH'");
  });

  it('vacío borra: viaja como null', () => {
    // No mandar el campo lo dejaría como estaba, que es lo contrario de
    // lo que pidió quien borró el correo en pantalla.
    expect(FICHA).toContain('email: borrador.email.trim() || null');
  });

  it('los campos propios del negocio también se editan', () => {
    // Antes solo se podían llenar importando la planilla.
    expect(FICHA).toContain('custom: borrador.custom');
    expect(FICHA).toContain("campos\n            .filter((d) => d.entity === 'contact')");
  });

  it('sí/no viaja como booleano, no como la palabra', () => {
    // El servidor rechaza 'true' con «es de sí o no», y el rechazo
    // llegaría recién al guardar.
    expect(FICHA).toContain('{ v: true, t: \'Sí\' }');
  });

  it('las opciones de lista se ofrecen, no se imponen', () => {
    // El servidor es quien rechaza una fuera de la lista, y su mensaje
    // dice cuál es la lista.
    expect(FICHA).toContain('<datalist');
  });

  it('el motivo del rechazo lo pone el dominio', () => {
    expect(FICHA).toContain('setAviso((err as Error).message)');
  });
});
