import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportsSinConsumidor, valoresQuePublica } from '../src/exports-sin-consumidor';

/**
 * La puerta pública de cada módulo, con trinquete (#664).
 *
 * `.claude/rules/arquitectura.md` dice que un módulo entra a otro SOLO por su
 * `contract.ts`. Esa regla vale porque el contrato es chico y deliberado. Medido
 * el 27/09: de 858 exports, **el 49 % no lo usaba nadie fuera de su módulo** —
 * o sea que «pasa por el contrato» había dejado de ser una decisión y era un
 * trámite: se exporta todo por si acaso.
 *
 * Y es el terreno donde crecen los defectos de esa semana. `presignPutUrl`
 * vivía así —exportado, probado, con CERO llamadores— mientras las tres puertas
 * que firmaban subidas usaban la versión insegura.
 *
 * Esto NO exige cero, y no es una lista de tareas. Es un trinquete: impide que
 * la deuda crezca y hace que cada PR que la baja deje constancia. Exigir cero
 * sería falso —hay exports esperando a un consumidor que viene— y pedir 201
 * motivos escritos es trabajo sin valor por entrada.
 */

const RAIZ = join(__dirname, '..', '..', '..');
const LISTA = join(RAIZ, 'docs', 'exports-sin-consumidor.txt');

const base = readFileSync(LISTA, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'));

describe('la puerta pública de los módulos (#664)', () => {
  it('el escáner encuentra algo (si esto falla, se rompió el escáner)', () => {
    const contrato = join(RAIZ, 'packages', 'modules', 'crm', 'contract.ts');
    const valores = valoresQuePublica(contrato);
    expect(valores.length).toBeGreaterThan(20);
    // Y NO incluye tipos: ese es el recorte que hace útil a esta guarda.
    expect(valores).not.toContain('Contact');
    expect(valores).toContain('createContact');
    // `MODULE_ID` lo exige la convención, no un consumidor.
    expect(valores).not.toContain('MODULE_ID');
  });

  it('la lista base está ordenada y sin repetidos: si no, el diff no se lee', () => {
    expect(base).toEqual([...base].sort());
    expect(new Set(base).size).toBe(base.length);
  });

  it('no aparece ningún export nuevo sin consumidor', () => {
    const ahora = exportsSinConsumidor([join(RAIZ, 'apps'), join(RAIZ, 'packages')]);
    const nuevos = ahora.filter((x) => !base.includes(x));
    expect(
      nuevos,
      'Estos se publican en un `contract.ts` y NO los usa nadie fuera de su ' +
        'módulo. Un módulo entra a otro solo por su contrato, y un contrato que ' +
        'expone lo que nadie abre deja de ser una decisión: es donde vivió ' +
        '`presignPutUrl`, exportado y probado, mientras las tres puertas que ' +
        'firmaban subidas usaban la versión insegura.\n\n' +
        '  Si tiene consumidor y no lo detecto, mira cómo se importa: se busca ' +
        'dentro de la sentencia `import … from \'@iaxti/module-x\'`.\n' +
        '  Si de verdad no lo tiene, no lo publiques todavía — déjalo interno ' +
        'hasta que alguien lo necesite.\n\n  ' +
        nuevos.join('\n  '),
    ).toEqual([]);
  });

  it('y si alguno consiguió consumidor, la marca BAJA', () => {
    const ahora = exportsSinConsumidor([join(RAIZ, 'apps'), join(RAIZ, 'packages')]);
    const resueltos = base.filter((x) => !ahora.includes(x));
    expect(
      resueltos,
      'Estos ya tienen consumidor: la marca tiene que bajar. Corre\n' +
        '  node scripts/exports-sin-consumidor.mjs --escribir\n' +
        'Sin esto el trinquete se afloja solo, y una deuda que no se ve bajar ' +
        'nunca baja:\n  ' +
        resueltos.join('\n  '),
    ).toEqual([]);
  });
});
