import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cada job programado llega a su `case`, y cada `case` lo encola alguien (#529).
 *
 * El defecto que esto viene a cazar: `markStalledDeals` existía, su comentario
 * decía «lo llama el job programado de workers», y ese job no existía. Nada
 * fallaba — no hay error cuando un job no se encola, simplemente no pasa nada —
 * y la consecuencia era invisible: `deals.stalled` nunca se ponía en true, la
 * insignia «Estancada» no aparecía nunca en el tablero, el widget del inicio
 * mostraba siempre cero detenidas, y el evento `deal.stalled` declarado en el
 * manifiesto de crm no se publicaba jamás.
 *
 * Se miran los DOS sentidos porque el defecto entra por los dos:
 *
 * - Un nombre encolado sin `case` cae en el `default`, que loguea «procesado» y
 *   devuelve `{ ok: true }`. O sea: el log dice que se hizo algo y no se hizo
 *   nada. Es el peor de los dos.
 * - Un `case` que nada encola es código muerto que parece vivo, y el próximo
 *   que lea el switch va a creer que ese trabajo se hace.
 */
const MAIN = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');

/** Los `case 'x':` del switch de jobs programados. */
function atendidos(): Set<string> {
  return new Set([...MAIN.matchAll(/case '([a-z][a-z0-9_.]*)':/g)].map((m) => m[1]));
}

/** Los nombres que `scheduled.add('x', …)` encola. */
function encolados(): Set<string> {
  return new Set([...MAIN.matchAll(/scheduled\.add\(\s*'([a-z][a-z0-9_.]*)'/g)].map((m) => m[1]));
}

/**
 * Los hijos que el padre encola por tenant: `enqueueTenantChildren(pool,
 * scheduled, 'x')` encola `x.tenant`, y ese nombre no aparece como literal en
 * ningún `scheduled.add`.
 */
function hijosPorTenant(): Set<string> {
  return new Set(
    [...MAIN.matchAll(/enqueueTenantChildren\([^,]+,\s*[^,]+,\s*'([a-z][a-z0-9_.]*)'\)/g)].map(
      (m) => `${m[1]}.tenant`,
    ),
  );
}

describe('los jobs programados y sus casos (#529)', () => {
  const casos = atendidos();
  const cola = encolados();
  const hijos = hijosPorTenant();

  it('el escáner encuentra algo (si esto falla, el escáner se rompió)', () => {
    expect(casos.size).toBeGreaterThan(10);
    expect(cola.size).toBeGreaterThan(10);
  });

  it('todo job encolado tiene un case que lo atienda', () => {
    const sinCaso = [...cola].filter((n) => !casos.has(n));
    expect(
      sinCaso,
      'Estos jobs se encolan y ningún `case` los atiende: caen en el `default`, ' +
        'que loguea "procesado" y devuelve ok. El log dice que se hizo y no se hizo:\n  ' +
        sinCaso.join('\n  '),
    ).toEqual([]);
  });

  it('todo case de job programado lo encola alguien', () => {
    // Los `case` de los otros switch del archivo (colas inbound/outbound) no
    // son jobs programados: se filtran por estar en la lista de encolados o de
    // hijos. Lo que queda y no está en ninguna es un caso al que no llega nada.
    const nombresDeCola = new Set([...cola, ...hijos]);
    const huerfanos = [...casos].filter(
      (n) => n.includes('.') && !nombresDeCola.has(n) && !n.endsWith('.tenant'),
    );
    expect(
      huerfanos,
      'Estos `case` no los encola nadie: código muerto que parece vivo, y el ' +
        'próximo que lea el switch va a creer que ese trabajo se hace:\n  ' + huerfanos.join('\n  '),
    ).toEqual([]);
  });

  it('el barrido de estancadas está cableado, que es el que faltaba', () => {
    // Explícito y no solo implícito en los dos tests de arriba: es el caso que
    // motivó esta guarda, y quiero que su ausencia falle con su nombre.
    expect(cola.has('crm.stalled'), 'falta encolar crm.stalled').toBe(true);
    expect(casos.has('crm.stalled'), 'falta el case de crm.stalled').toBe(true);
    expect(MAIN).toContain('markStalledDeals');
  });
});
