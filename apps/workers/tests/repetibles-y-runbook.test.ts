import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPETIBLES } from '../src/repetibles';

/**
 * La tabla del runbook y la lista del código son DOS declaraciones del mismo
 * conjunto, y se habían separado: la tabla del §4 de ANTES-DE-PRODUCCION.md
 * nombraba cinco de diecisiete tareas (#807).
 *
 * Eso no es un documento incompleto: es una comprobación que no puede ver el
 * fallo. Un operador que lee «si no corre, pasa esto» en cinco filas da por
 * cubiertas las otras doce, y las doce incluyen el recordatorio de la hora de
 * un cliente y el cobro del consumo de API.
 *
 * Por eso esta guarda y no una revisión a mano: la tabla se separa sola la
 * próxima vez que alguien agregue una tarea, y nadie se va a acordar.
 */
const RUNBOOK = join(__dirname, '..', '..', '..', 'docs', 'runbooks', 'ANTES-DE-PRODUCCION.md');

function tareasDelRunbook(): string[] {
  const texto = readFileSync(RUNBOOK, 'utf8');
  const seccion = texto.slice(
    texto.indexOf('## 4. El worker de tareas programadas'),
    texto.indexOf('## 5. '),
  );
  expect(seccion, 'no se encontró el §4 del runbook').not.toBe('');
  return [...seccion.matchAll(/^\| `([a-z_]+\.[a-z_.]+)` \|/gm)].map((m) => m[1]);
}

describe('el runbook nombra TODAS las tareas repetibles (#807)', () => {
  it('ni una de menos: la tabla del §4 las tiene todas', () => {
    const enElRunbook = new Set(tareasDelRunbook());
    const faltan = REPETIBLES.map((r) => r.nombre).filter((n) => !enElRunbook.has(n));
    expect(
      faltan,
      'Tareas que el worker programa y el runbook del §4 no nombra. Agrégalas a la tabla ' +
        'con qué pasa si NO corren, que es para lo que sirve:\n  ' + faltan.join('\n  '),
    ).toEqual([]);
  });

  it('ni una de más: el runbook no promete tareas que no existen', () => {
    const programadas = new Set(REPETIBLES.map((r) => r.nombre));
    const fantasmas = tareasDelRunbook().filter((n) => !programadas.has(n));
    expect(
      fantasmas,
      `El runbook nombra tareas que el worker no programa: ${fantasmas.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * Anti-vacuidad: si el recorte del §4 o la expresión del nombre se rompen,
   * las dos de arriba quedan verdes con listas vacías. La lección de #790.
   */
  it('la guarda está mirando algo: veintiuna a cada lado', () => {
    expect(REPETIBLES).toHaveLength(21);
    expect(tareasDelRunbook()).toHaveLength(21);
  });

  it('ningún nombre repetido: dos entradas con el mismo nombre son una sola tarea', () => {
    const nombres = REPETIBLES.map((r) => r.nombre);
    expect(new Set(nombres).size).toBe(nombres.length);
  });
});
