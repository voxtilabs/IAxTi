import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { OutboxDispatcher } from '../src/dispatcher';
import type { ModuleRegistry } from '../src/registry';

function pendiente() {
  let resolve!: (value: number) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<number>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const instancias: OutboxDispatcher[] = [];
function escenario() {
  vi.useFakeTimers();
  // El lote retenido representa una consulta/consumidor lento. Los tests
  // de outbox.test.ts cubren el tick real con PostgreSQL e idempotencia.
  const dispatcher = new OutboxDispatcher({} as Pool, {} as ModuleRegistry, []);
  instancias.push(dispatcher);
  const lote = pendiente();
  const tick = vi.spyOn(dispatcher, 'tick').mockReturnValueOnce(lote.promise).mockResolvedValue(0);
  return { dispatcher, lote, tick };
}

afterEach(() => {
  for (const dispatcher of instancias.splice(0)) dispatcher.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('sondeo del outbox bajo demora (#377)', () => {
  it('no acumula lotes mientras el primero espera; vuelve a sondear al terminar', async () => {
    const { dispatcher, lote, tick } = escenario();
    dispatcher.start(500);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(1);
    lote.resolve(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('un error libera el sondeo y se registra una sola vez', async () => {
    const { dispatcher, lote, tick } = escenario();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    dispatcher.start(500);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tick).toHaveBeenCalledTimes(1);
    const error = new Error('conexión interrumpida');
    lote.reject(error);
    await vi.advanceTimersByTimeAsync(500);
    expect(log).toHaveBeenCalledExactlyOnceWith('outbox tick falló:', error);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('stop/start durante un lote no abre otro en paralelo', async () => {
    const { dispatcher, lote, tick } = escenario();
    dispatcher.start(500);
    await vi.advanceTimersByTimeAsync(500);
    dispatcher.stop();
    dispatcher.start(500);
    dispatcher.start(500);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tick).toHaveBeenCalledTimes(1);
    lote.resolve(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('stop permite terminar el lote actual sin crear nuevos', async () => {
    const { dispatcher, lote, tick } = escenario();
    dispatcher.start(500);
    await vi.advanceTimersByTimeAsync(500);
    dispatcher.stop();
    lote.resolve(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
