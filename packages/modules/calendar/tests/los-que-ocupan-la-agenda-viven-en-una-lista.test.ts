import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';
import { ESTADOS_QUE_OCUPAN, ocupaAgenda } from '../domain/estado';

/**
 * Qué estados ocupan la agenda se decide en UN lugar (#1251).
 *
 * La regla estaba escrita a mano en cada SELECT de choque de `agenda.ts` —y a
 * la vez en `ocupaAgenda`, que se exportaba sin que ninguna consulta la
 * usara—. Dos copias de la misma regla no se notan hasta que alguien agrega
 * un estado a una y no a la otra: la base deja de ofrecer una hora que el
 * dominio cree tomada, o al revés, y el síntoma es una cita doble que nadie
 * pidió.
 *
 * La pregunta de esta guarda es «¿está escrito en una sola fuente?», no «¿qué
 * pasa cuando alguien agenda?»: eso lo miden las pruebas de comportamiento
 * contra Postgres, que ya existen.
 */
const MODULO = join(__dirname, '..');
const UNICA_FUENTE = join('domain', 'estado.ts');

function* fuentes(dir: string): Generator<string> {
  for (const entrada of readdirSync(dir)) {
    if (['node_modules', 'dist', 'tests'].includes(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) yield* fuentes(ruta);
    else if (/\.tsx?$/.test(entrada)) yield ruta;
  }
}

describe('los estados que ocupan la agenda viven en una sola lista', () => {
  it('nadie fuera de domain/estado.ts escribe la lista a mano', () => {
    const culpables: string[] = [];
    for (const ruta of fuentes(MODULO)) {
      if (ruta === join(MODULO, UNICA_FUENTE)) continue;
      // Se escanea LIMPIO (#569): un comentario que cite la lista vieja no
      // puede poner la guarda roja.
      const limpio = fuenteLimpia(readFileSync(ruta, 'utf8'));
      if (/'proposed'\s*,\s*'confirmed'\s*,\s*'reminded'/.test(limpio)) {
        culpables.push(ruta.slice(MODULO.length + 1));
      }
    }
    expect(
      culpables,
      'Pasá ESTADOS_QUE_OCUPAN de ../domain/estado como parámetro (= ANY(...)) ' +
        'y usa ocupaAgenda en JS. Una segunda copia de esta lista es cómo la ' +
        'base y el dominio dejan de estar de acuerdo en qué hora está tomada.',
    ).toEqual([]);
  });

  it('la lista y ocupaAgenda dicen lo mismo, que es lo que las consultas pasan', () => {
    // Anti-vacuidad: la guarda de arriba no sirve si la fuente única está
    // vacía o si `ocupaAgenda` dejó de leerla.
    expect([...ESTADOS_QUE_OCUPAN]).toEqual(['proposed', 'confirmed', 'reminded']);
    for (const estado of ['attended', 'no_show', 'cancelled', 'rescheduled'] as const) {
      expect(ocupaAgenda(estado)).toBe(false);
    }
    expect(ESTADOS_QUE_OCUPAN.every(ocupaAgenda)).toBe(true);
  });
});
