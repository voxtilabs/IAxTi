import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Corregir una plantilla (#460).
 *
 * `PUT /plantillas/:id` existe desde #44 y no la llamaba nadie: una
 * plantilla que Meta rechazó —o una con una falta de ortografía— solo se
 * podía arreglar creando otra, y la rechazada se quedaba en la lista para
 * siempre con su motivo de rechazo.
 */
const PLANTILLAS = readFileSync(join(__dirname, '..', 'components', 'plantillas.tsx'), 'utf8');

describe('corregir una plantilla', () => {
  it('el mismo formulario crea y corrige', () => {
    expect(PLANTILLAS).toContain('editando ? `/plantillas/${editando}` : \'/plantillas\'');
    expect(PLANTILLAS).toContain("method: editando ? 'PUT' : 'POST'");
  });

  it('solo se ofrece en las que se pueden editar', () => {
    // Una en revisión o aprobada la tiene Meta: el servidor lo rechaza, y
    // ofrecerlo igual sería prometer algo que no es.
    expect(PLANTILLAS).toContain("p.status === 'draft' || p.status === 'rejected'");
  });

  it('se puede dejar como estaba', () => {
    expect(PLANTILLAS).toContain('Dejarla como estaba');
  });

  it('al terminar, el formulario vuelve a ser el de crear', () => {
    expect(PLANTILLAS).toContain('setEditando(null)');
  });
});
