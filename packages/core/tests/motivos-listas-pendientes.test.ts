import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fuenteLimpia } from '../src/testing/fuente-limpia';

const raiz = join(__dirname, '..', '..', '..');
const pendientes = readFileSync(join(raiz, 'docs/listas-sin-vacio.txt'), 'utf8')
  .split('\n').map((linea) => linea.trim()).filter((linea) => linea && !linea.startsWith('#'));
const { entradas } = JSON.parse(
  readFileSync(join(raiz, 'docs/listas-sin-vacio-motivos.json'), 'utf8'),
) as { entradas: Record<string, { motivo: string; evidencia: { archivo: string; fragmento: string } }> };

// #588 exige motivos por pendiente. Mantenerlos separados permite regenerar
// el trinquete sin borrarlos; esta guarda impide que las dos listas diverjan.
describe('motivos de los estados vacíos pendientes (#588)', () => {
  it('cada entrada actual tiene motivo y ninguna resuelta conserva uno obsoleto', () => {
    expect(Object.keys(entradas).sort()).toEqual([...pendientes].sort());
  });

  for (const [entrada, { motivo, evidencia }] of Object.entries(entradas)) {
    it(`el motivo de ${entrada} conserva evidencia en la fuente`, () => {
      expect(motivo.trim().length).toBeGreaterThan(60);
      expect(evidencia.archivo).toBe(`apps/web/components/${entrada.split('#')[0]}`);
      expect(evidencia.fragmento.trim().length).toBeGreaterThan(10);
      const fuente = fuenteLimpia(readFileSync(join(raiz, evidencia.archivo), 'utf8'));
      expect(fuente, `${entrada}: actualizar el motivo si cambió su evidencia`).toContain(evidencia.fragmento);
    });
  }
});
