import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Editar una empresa (#480).
 *
 * `PUT /empresas/:id` existe desde #217 y no la llamaba nadie: un nombre
 * mal escrito o un RUT que faltaba solo se arreglaban archivándola y
 * creando otra — y con ella se iban los contactos colgados.
 */
const EMPRESAS = readFileSync(join(__dirname, '..', 'components', 'empresas.tsx'), 'utf8');

describe('editar una empresa', () => {
  it('guarda contra la ruta que ya existía', () => {
    expect(EMPRESAS).toContain('`/empresas/${e.id}`');
    expect(EMPRESAS).toContain("method: 'PUT'");
  });

  it('el RUT vacío borra, no deja el anterior', () => {
    expect(EMPRESAS).toContain("rut: edicion.rut.trim() || null");
  });

  it('no se ofrece en las archivadas', () => {
    // Editar una archivada invita a revivirla a medias: primero se
    // desarchiva.
    const bloque = EMPRESAS.slice(EMPRESAS.indexOf('{!e.archivedAt && ('));
    expect(bloque.slice(0, 900)).toContain('Editar');
  });

  it('se puede dejar como estaba', () => {
    expect(EMPRESAS).toContain('Dejar como estaba');
  });
});
