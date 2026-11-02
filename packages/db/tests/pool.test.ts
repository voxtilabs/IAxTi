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
  delete process.env.DB_IDLE_TIMEOUT_MS;
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

/**
 * Las conexiones se guardan en vez de soltarse a los 30 s (#1173).
 *
 * Lo que esto evita, medido en Sentry el 02-11: 22 errores en 3 horas en
 * staging, todos `Connection terminated due to connection timeout`, y 23 de
 * los 25 issues sin resolver en 14 días. Entre ellos `GET /v1/onboarding`,
 * que es la pantalla donde se conecta WhatsApp: el dueño no pudo abrirla.
 *
 * El mecanismo: con 30 s, medio minuto de silencio deja el pool vacío, y la
 * siguiente petición tiene que resolver DNS, abrir TCP, negociar TLS y
 * autenticar contra un pooler compartido. El DNS de ese VPS falla seguido
 * —`EAI_AGAIN` 38 veces en la misma lista—, así que cada reconexión es otra
 * tirada de esa moneda.
 *
 * Se prueba la CONFIGURACIÓN y no el comportamiento a propósito: comprobar
 * que una conexión sobrevive cinco minutos ociosa es una prueba de cinco
 * minutos, y lo que se rompe acá no es el comportamiento de `pg` sino el
 * número que le pasamos.
 */
describe('las conexiones ociosas no se sueltan enseguida', () => {
  it('cinco minutos por defecto, no treinta segundos', () => {
    const pool = createPool(URL_BASE);
    try {
      expect(pool.options.idleTimeoutMillis).toBe(300_000);
    } finally {
      void pool.end();
    }
  });

  it('se puede ajustar por entorno, porque depende del pooler de cada despliegue', () => {
    process.env.DB_IDLE_TIMEOUT_MS = '60000';
    const pool = createPool(URL_BASE);
    try {
      expect(pool.options.idleTimeoutMillis).toBe(60_000);
    } finally {
      void pool.end();
    }
  });

  it('un valor que no sirve avisa y cae al de siempre, no deja el pool sin tope', () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.DB_IDLE_TIMEOUT_MS = 'un rato';
    const pool = createPool(URL_BASE);
    try {
      expect(pool.options.idleTimeoutMillis).toBe(300_000);
      expect(aviso).toHaveBeenCalled();
    } finally {
      void pool.end();
    }
  });

  it('el socket se mantiene vivo: un NAT no puede matar la conexión en silencio', () => {
    // Sin esto, un VPS detrás de NAT pierde la conexión TCP ociosa sin que
    // ninguno de los dos lados se entere, y la siguiente consulta escribe en
    // un socket muerto. Desde afuera se ve idéntico a un timeout.
    const pool = createPool(URL_BASE);
    try {
      expect(pool.options.keepAlive).toBe(true);
    } finally {
      void pool.end();
    }
  });

  it('conseguir conexión tiene diez segundos, y SIGUE teniendo tope', () => {
    // El tope no se negocia: con 0 `pg` espera para siempre y la petición se
    // cuelga en vez de fallar, que es lo que arregló #361.
    const pool = createPool(URL_BASE);
    try {
      expect(pool.options.connectionTimeoutMillis).toBe(10_000);
      expect(pool.options.connectionTimeoutMillis).toBeGreaterThan(0);
    } finally {
      void pool.end();
    }
  });
});
