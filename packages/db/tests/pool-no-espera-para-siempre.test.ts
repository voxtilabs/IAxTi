import { describe, expect, it } from 'vitest';
import { createPool } from '../src/client';

/**
 * El pool no espera para siempre (#241).
 *
 * `pg` trae `connectionTimeoutMillis: 0` — esperar indefinidamente. Con una
 * base que no contesta (paquetes perdidos, no rechazo), cada consulta se
 * cuelga sin decir nada y la aplicación se ve viva sin poder hacer nada.
 *
 * Eso fue staging durante días: `/health` en 200 y `/ready` colgado en su
 * propio tope, sin una sola pista en los logs.
 */
describe('el pool cuando la base no contesta', () => {
  it('se rinde y lo dice, en vez de colgarse', async () => {
    // Una IP que se traga los paquetes: no rechaza, no contesta. Es el
    // comportamiento que hay que reproducir — un "conexión rechazada"
    // siempre falló rápido y nunca fue el problema.
    const pool = createPool('postgres://quien:sea@192.0.2.1:5432/nada');
    const inicio = Date.now();
    await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout/i);
    const tardo = Date.now() - inicio;
    // Se rinde cerca del tope, no a los 30 segundos ni nunca.
    expect(tardo).toBeLessThan(15_000);
    await pool.end().catch(() => {});
  }, 30_000);

  it('el tope se puede bajar por entorno, para un arranque más exigente', async () => {
    const antes = process.env.DB_CONNECT_TIMEOUT_MS;
    process.env.DB_CONNECT_TIMEOUT_MS = '300';
    try {
      const pool = createPool('postgres://quien:sea@192.0.2.1:5432/nada');
      const inicio = Date.now();
      await expect(pool.query('SELECT 1')).rejects.toThrow();
      expect(Date.now() - inicio).toBeLessThan(3_000);
      await pool.end().catch(() => {});
    } finally {
      if (antes === undefined) delete process.env.DB_CONNECT_TIMEOUT_MS;
      else process.env.DB_CONNECT_TIMEOUT_MS = antes;
    }
  }, 15_000);
});
