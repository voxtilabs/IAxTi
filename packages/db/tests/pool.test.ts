import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPool } from '../src/client';

/**
 * Una conexión ociosa que se muere no tumba la petición (#395).
 *
 * `pg` emite `'error'` en el pool cuando el servidor cierra una conexión
 * guardada sin usar — cosa que un pooler hace todo el tiempo. Sin nadie
 * escuchando, Node lo trata como error no manejado: se va a Sentry con una
 * pila que no pasa por nuestro código y se lleva por delante la petición
 * que tocaba.
 *
 * Está medido, no supuesto: diez de los doce issues del proyecto en Sentry
 * son esto, incluido el 500 que perdió un mensaje entrante (#361).
 */
const URL_BASE = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DB_POOL_MAX;
});

describe('el pool aguanta que se le muera una conexión', () => {
  it('escucha el error en vez de dejarlo sin manejar', async () => {
    const pool = createPool(URL_BASE);
    try {
      // Sin listener, `emit('error')` en un EventEmitter LANZA. Con
      // listener, no. Es exactamente la diferencia que se paga en
      // producción.
      expect(pool.listenerCount('error')).toBeGreaterThan(0);
      const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
      expect(avisos).toHaveBeenCalledOnce();
      // El aviso dice qué NO pasó, que es lo que evita el susto.
      expect(avisos.mock.calls[0][0]).toContain('NO se vio afectada');
    } finally {
      await pool.end();
    }
  });

  it('el tope de conexiones es una decisión, no el defecto de pg', async () => {
    const pool = createPool(URL_BASE);
    try {
      // pg trae 10. Con dos servicios y réplicas, contra una instancia de
      // 60 conexiones donde Supabase ya se lleva unas quince, elegirlo
      // importa.
      expect(pool.options.max).toBe(6);
    } finally {
      await pool.end();
    }
  });

  it('se puede ajustar por entorno, y un valor basura no lo rompe', async () => {
    for (const [valor, esperado] of [['12', 12], ['3.7', 3], ['0', 6], ['hola', 6], ['', 6]] as const) {
      process.env.DB_POOL_MAX = valor;
      const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pool = createPool(URL_BASE);
      try {
        expect(pool.options.max, `DB_POOL_MAX="${valor}"`).toBe(esperado);
      } finally {
        await pool.end();
        avisos.mockRestore();
      }
    }
  });

  it('sigue sirviendo consultas después de perder una conexión', async () => {
    const pool = createPool(URL_BASE);
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      pool.emit('error', new Error('Connection terminated unexpectedly'));
      const r = await pool.query('select 1 as uno');
      expect(r.rows[0].uno).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
