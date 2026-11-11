import { beforeEach, describe, expect, it } from 'vitest';
import { getProvider, proveedorDe, registerProvider, resetProviders } from '@iaxti/module-channels';
import { createZavuProvider } from '../application/zavu';
import { createZernioProvider } from '../application/zernio';

/**
 * Zernio se registra AL LADO de Zavu, no en su lugar (#1317, ADR-0032).
 *
 * `el-proveedor-es-de-la-cuenta.test.ts` (en channels) ya prueba el registro
 * por (proveedor, canal) — pero con adaptadores de mentira, que solo se
 * distinguen por quién dicen ser. Esta es la misma prueba con los adaptadores
 * REALES que registran la API y los workers al arrancar: es la que cae si
 * alguien cambia el `proveedor` que declara el adaptador de Zernio, o el orden
 * en que `main.ts` registra los dos.
 *
 * El registro es estado de proceso: cada caso arma el suyo desde cero, y el
 * que restaura en `afterEach` es `resetProviders` — importado del puerto, no
 * una re-implementación.
 */

/** El orden de arranque de `main.ts`: Zavu primero, Zernio al lado. */
function registrarLosDos() {
  const deZavu = createZavuProvider('whatsapp');
  const deZernio = createZernioProvider('whatsapp');
  registerProvider(deZavu);
  registerProvider(deZernio);
  return { deZavu, deZernio };
}

beforeEach(resetProviders);

describe('con los adaptadores reales, zernio no le quita el canal a zavu', () => {
  it('getProvider("whatsapp") sigue devolviendo a Zavu tras registrar los dos', () => {
    const { deZavu, deZernio } = registrarLosDos();

    // El por omisión declarado, no «el que esté»: ninguna cuenta existente
    // cambia de camino por existir Zernio.
    expect(getProvider('whatsapp')).toBe(deZavu);
    expect(getProvider('whatsapp')).not.toBe(deZernio);
  });

  it('la cuenta que declara zernio resuelve al adaptador de Zernio', () => {
    const { deZavu, deZernio } = registrarLosDos();

    expect(proveedorDe({ kind: 'whatsapp', provider: 'zernio' })).toBe(deZernio);
    expect(proveedorDe({ kind: 'whatsapp', provider: 'zernio' })).not.toBe(deZavu);
    // Y sin declarar nada —la cuenta anterior a la ADR-0032—, el de siempre.
    expect(proveedorDe({ kind: 'whatsapp' })).toBe(deZavu);
  });

  it('el orden de registro no decide quién atiende: Zernio primero, igual', () => {
    // La versión del registro que resolvía por canal devolvía «el único que
    // hay»: registrado Zernio primero, whatsapp pasaba a ser suyo. El orden
    // de arranque no puede ser una decisión de arquitectura.
    const deZernio = createZernioProvider('whatsapp');
    const deZavu = createZavuProvider('whatsapp');
    registerProvider(deZernio);
    registerProvider(deZavu);

    expect(getProvider('whatsapp')).toBe(deZavu);
    expect(proveedorDe({ kind: 'whatsapp', provider: 'zernio' })).toBe(deZernio);
  });
});