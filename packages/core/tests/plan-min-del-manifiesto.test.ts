import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { findModulesDir, loadAllManifests } from '../src/manifest';
import { planMinQueMiente, planesDelSeed } from '../src/plan-min-del-manifiesto';

/**
 * El `plan_min` del manifiesto nombra el plan más barato que de verdad vende
 * el módulo (#834).
 *
 * `plan_min` está en los diecinueve manifiestos y lo lee cero código: el
 * acceso por plan sale solo de `plan_limits`. Son dos declaraciones de lo
 * mismo, y la que está a la vista en el repo es la inerte — así que se separó
 * sin que nada avisara: cuatro módulos que se venden desde un plan de arriba
 * decían `plan_min: base`.
 */
const MODULES = findModulesDir();
const SEED = join(MODULES, 'organizations', 'migrations', '0002_tenant_lifecycle.sql');

const planes = planesDelSeed(SEED);
const modulos = loadAllManifests(MODULES).map((m) => ({
  id: m.module.id,
  planMin: m.plan_min,
}));

describe('el plan_min del manifiesto y los planes sembrados dicen lo mismo', () => {
  it('la guarda está mirando algo: hay planes con módulos y manifiestos con plan_min', () => {
    // Anti-vacuidad: si el parseo del seed fallara, `planMinQueMiente` no
    // encontraría «el primer plan que lo vende» para ninguno y devolvería la
    // lista vacía — verde sin medir nada.
    expect(planes.length).toBeGreaterThanOrEqual(3);
    expect(planes.every((p) => p.modulos.length > 0)).toBe(true);
    expect(modulos.filter((m) => m.planMin).length).toBeGreaterThan(15);
    // Y que haya módulos VENDIBLES, que son los únicos que esto compara.
    const vendibles = modulos.filter((m) => planes.some((p) => p.modulos.includes(m.id)));
    expect(vendibles.length).toBeGreaterThan(5);
  });

  it('ningún plan_min nombra un plan que no vende ese módulo', () => {
    const malos = planMinQueMiente(modulos, planes).map(
      (m) => `${m.modulo}: dice \`${m.dice}\` y se vende desde \`${m.deberia}\``,
    );
    expect(
      malos,
      'El `plan_min` del manifiesto y `plan_limits` del seed no dicen lo mismo. Quien lea el ' +
        'manifiesto va a creer que el módulo viene en un plan que no lo trae:\n  ' +
        malos.join('\n  '),
    ).toEqual([]);
  });

  it('la infraestructura no entra: ningún plan la vende y plan_min: base es correcto', () => {
    // `modulosVendibles` lo dice así: «un módulo se cobra por plan si ALGÚN
    // plan lo vende; el resto es infraestructura, no se vende por separado».
    const infra = modulos.filter((m) => !planes.some((p) => p.modulos.includes(m.id)));
    expect(infra.map((m) => m.id)).toContain('channels');
    expect(infra.map((m) => m.id)).toContain('whatsapp');
    // Y la guarda no los reporta, aunque digan `base`.
    expect(planMinQueMiente(infra, planes)).toEqual([]);
  });

  it('caza las dos formas de mentir, con entrada sintética', () => {
    const deJuguete = [
      { plan: 'base', modulos: ['crm'] },
      { plan: 'crece', modulos: ['crm', 'automations'] },
    ];
    // Decir un plan MÁS BARATO del que lo vende: el caso que había.
    expect(planMinQueMiente([{ id: 'automations', planMin: 'base' }], deJuguete)).toEqual([
      { modulo: 'automations', dice: 'base', deberia: 'crece' },
    ]);
    // Y decir uno más caro, que entrega de menos.
    expect(planMinQueMiente([{ id: 'crm', planMin: 'crece' }], deJuguete)).toEqual([
      { modulo: 'crm', dice: 'crece', deberia: 'base' },
    ]);
    // Sin `plan_min`, se nombra igual: un vendible sin plan declarado no dice nada.
    expect(planMinQueMiente([{ id: 'crm' }], deJuguete)).toEqual([
      { modulo: 'crm', dice: '(sin plan_min)', deberia: 'base' },
    ]);
  });

  it('si el seed se mueve, la guarda GRITA en vez de quedarse vacía', () => {
    expect(() => planesDelSeed(join(MODULES, 'organizations', 'module.yaml'))).toThrow(
      /no se encontró el INSERT de plan_limits/,
    );
  });
});
