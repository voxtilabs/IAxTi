import { describe, expect, it } from 'vitest';
import { entornoConCoalescencia } from '../src/entorno-con-coalescencia';
import { join } from 'node:path';

const RAIZ = join(__dirname, '..', '..', '..');

/**
 * La guarda de #575: ninguna lectura del entorno se escribe con `??` y un
 * valor por defecto, porque `??` no atrapa la cadena vacía.
 *
 * Esta lista está VACÍA a propósito, y eso es la mitad del valor. Las catorce
 * que había se arreglaron en el mismo PR: dejar un trinquete con números
 * («de 14 no pasar») habría conservado el defecto y la costumbre. Si mañana
 * aparece una excepción de verdad, se agrega acá con su motivo escrito; lo
 * que no se puede es agregarla en silencio.
 */
const PERMITIDAS: string[] = [];

describe('lecturas del entorno con ?? (#575)', () => {
  it('ninguna variable de entorno cae a su defecto con ??', () => {
    const hallazgos = entornoConCoalescencia([
      join(RAIZ, 'apps'),
      join(RAIZ, 'packages'),
    ]).filter((h) => !PERMITIDAS.includes(`${h.archivo.slice(RAIZ.length + 1)}:${h.variable}`));

    expect(
      hallazgos.map((h) => `${h.archivo.slice(RAIZ.length + 1)}:${h.linea} → ${h.variable}`),
    ).toEqual([]);
  });

  it('acepta las formas que sí normalizan la cadena vacía', () => {
    // Un archivo de verdad del repo que usa la forma aceptada: si alguien la
    // «arregla» a `??` o si la guarda empieza a cazarla, esto se cae.
    const aceptadas = entornoConCoalescencia([join(RAIZ, 'apps', 'web', 'lib')]);
    expect(aceptadas).toEqual([]);
  });
});
