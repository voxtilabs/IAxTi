import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Ningún `${{ … }}` dentro de un `run:` (#758).
 *
 * Una interpolación de GitHub Actions se expande **antes** de que bash vea el
 * script: lo que haya adentro pasa a ser parte del programa, no un valor. Si eso
 * viene de un input del dispatch, del título de un PR o de una salida que a su
 * vez salió de un input, un `; curl …` ahí es ejecución de código en el runner —
 * con los secretos del job a mano.
 *
 * El remedio es siempre el mismo y es barato: pasarlo por `env:` y leerlo como
 * variable, que bash trata como dato. Por eso la regla es «ninguno» y no «ninguno
 * de los peligrosos»: distinguir cuáles son seguros es justo el juicio que se
 * equivoca —`github.actor` parece inofensivo, una salida de otro paso parece
 * confiable— y `env:` no cuesta nada.
 *
 * Semgrep caza esto en CI, pero desde #756 solo bloquea lo que cada PR
 * introduce y corre allá, no acá. Esta guarda corre en
 * `scripts/antes-de-empujar.sh`, o sea antes de empujar, que es cuando sirve.
 *
 * Lo que encontró al escribirse: cinco casos en cuatro workflows —el input del
 * escaneo ZAP, el motivo del rollback (texto libre, escrito bajo presión), y
 * tres `docker login` que interpolaban el token y el nombre de quien dispara.
 */
const WORKFLOWS = join(import.meta.dirname, '../../../.github/workflows');

/**
 * Lo que sí puede quedar interpolado, con su motivo.
 *
 * Vacía hoy, a propósito. No es que no existan casos imaginables: es que no
 * hemos encontrado ninguno donde `env:` no sirva igual, y tener que escribir el
 * porqué es lo que impide que la lista crezca sola.
 */
const PERMITIDAS: Record<string, string> = {};

interface Paso {
  run?: unknown;
  name?: unknown;
}

function pasosConRun(archivo: string): Array<{ paso: Paso; job: string }> {
  const doc = parse(readFileSync(join(WORKFLOWS, archivo), 'utf8')) as {
    jobs?: Record<string, { steps?: Paso[] }>;
  };
  const salida: Array<{ paso: Paso; job: string }> = [];
  for (const [job, cuerpo] of Object.entries(doc.jobs ?? {})) {
    for (const paso of cuerpo.steps ?? []) {
      if (typeof paso?.run === 'string') salida.push({ paso, job });
    }
  }
  return salida;
}

describe('ningún ${{ }} dentro de un run: (#758)', () => {
  const archivos = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'));

  it('hay workflows que mirar', () => {
    expect(archivos.length).toBeGreaterThan(5);
  });

  it('las interpolaciones van por env:, no dentro del script', () => {
    const hallazgos: string[] = [];
    for (const archivo of archivos) {
      for (const { paso, job } of pasosConRun(archivo)) {
        for (const m of String(paso.run).matchAll(/\$\{\{([^}]*)\}\}/g)) {
          const expresion = m[1].trim();
          if (expresion in PERMITIDAS) continue;
          hallazgos.push(`${archivo} · job ${job} · paso "${String(paso.name ?? '(sin nombre)')}" · \${{ ${expresion} }}`);
        }
      }
    }
    expect(
      hallazgos,
      'Estas interpolaciones viven DENTRO de un `run:` y se expanden antes de que bash vea el ' +
        'script, así que su contenido es programa y no dato:\n  ' +
        hallazgos.join('\n  ') +
        '\nPásalas por `env:` y léelas como variable (`"${MI_VAR}"`). Si de verdad no se puede, ' +
        'va a PERMITIDAS con su motivo.',
    ).toEqual([]);
  });
});
