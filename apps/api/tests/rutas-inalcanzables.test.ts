import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Una ruta literal declarada DESPUÉS de una con parámetro no existe (#657).
 *
 * NestJS resuelve en orden de declaración. Con `@Get(':id')` arriba,
 * `GET /contacts/activities` entraba por la ficha con `id = 'activities'`, no
 * encontraba nada, y salía como 404 `CONTACT_NOT_FOUND`. La pantalla de
 * Pendientes —la que responde «¿qué tengo que hacer hoy?»— mostraba su estado
 * vacío y **nunca pudo mostrar una sola actividad**.
 *
 * Es la peor forma de romperse: no falla ruidosamente, dice que estás al día.
 *
 * Y la guarda que existía no lo veía. `rutas-frontend` (#360) comprueba que toda
 * llamada del front tenga una ruta DECLARADA, y esta lo estaba: escrita, con su
 * permiso y su OpenAPI. Lo que no se miraba es si era ALCANZABLE. Otra vez
 * declarado en un lado y aplicado en ninguno, solo que acá el que lo tapa es el
 * framework.
 */

const DIR = join(__dirname, '..', 'src');

/** Sin comentarios: los de este repo nombran rutas todo el tiempo. */
function sinComentarios(fuente: string): string {
  return fuente
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

interface Declarada {
  verbo: string;
  camino: string;
  linea: number;
}

function rutasDe(fuente: string): Declarada[] {
  const salida: Declarada[] = [];
  const lineas = sinComentarios(fuente).split('\n');
  lineas.forEach((l, i) => {
    const m = /@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/.exec(l);
    if (m) salida.push({ verbo: m[1], camino: m[2] ?? '', linea: i + 1 });
  });
  return salida;
}

/**
 * ¿Este camino es un literal que una ruta con parámetro ya se come?
 *
 * Se compara segmento a segmento: `:algo` se traga cualquier literal en esa
 * posición. `activities` contra `:id` → sí. `:id/titular` contra `:id` → no,
 * porque tiene un segmento más.
 */
function loTapa(anterior: string, posterior: string): boolean {
  const a = anterior.split('/').filter(Boolean);
  const b = posterior.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  let comeAlgo = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) {
      // Un parámetro se come un literal, pero no a otro parámetro: dos rutas
      // con parámetro en la misma posición son la misma ruta, y eso es otro
      // problema (NestJS avisa).
      if (b[i].startsWith(':')) return false;
      comeAlgo = true;
      continue;
    }
    if (a[i] !== b[i]) return false;
  }
  return comeAlgo;
}

const archivos = readdirSync(DIR).filter((f) => f.endsWith('.controller.ts'));

describe('ninguna ruta queda tapada por otra con parámetro (#657)', () => {
  it('el escáner encuentra rutas (si esto falla, se rompió el escáner)', () => {
    const total = archivos.reduce(
      (n, f) => n + rutasDe(readFileSync(join(DIR, f), 'utf8')).length,
      0,
    );
    expect(total).toBeGreaterThan(50);
  });

  it('toda ruta literal se declara ANTES que la que lleva parámetro', () => {
    const tapadas: string[] = [];
    for (const archivo of archivos) {
      const rutas = rutasDe(readFileSync(join(DIR, archivo), 'utf8'));
      for (let i = 0; i < rutas.length; i++) {
        for (let j = 0; j < i; j++) {
          if (rutas[j].verbo !== rutas[i].verbo) continue;
          if (loTapa(rutas[j].camino, rutas[i].camino)) {
            tapadas.push(
              `${archivo}: @${rutas[i].verbo}('${rutas[i].camino}') en la línea ${rutas[i].linea} ` +
                `la tapa @${rutas[j].verbo}('${rutas[j].camino}') de la línea ${rutas[j].linea}`,
            );
          }
        }
      }
    }
    expect(
      tapadas,
      'Estas rutas NO se pueden alcanzar: NestJS resuelve en orden de ' +
        'declaración, así que la de arriba se las come. No fallan ruidosamente —' +
        'contestan lo que conteste la otra ruta, normalmente un 404— y la pantalla ' +
        'que las llama se ve vacía:\n  ' +
        tapadas.join('\n  '),
    ).toEqual([]);
  });
});
