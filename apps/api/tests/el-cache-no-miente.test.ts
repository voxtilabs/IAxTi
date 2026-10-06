import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { usarRedis } from '../src/db';

/**
 * El caché de lecturas, por el lado que hace daño (#711).
 *
 * Existe por una medición: desde dentro del VPS, **postgres 64 ms** por consulta
 * y **redis 0 ms**. La base es Supabase y está lejos. Abrir una conversación son
 * 21 peticiones, y la lista de campos propios la leen casi todas las pantallas
 * del CRM aunque cambie casi nunca.
 *
 * Lo que estas pruebas cuidan no es que sea rápido —eso se mide con un
 * cronómetro, no con una aserción— sino las dos formas en que un caché empeora
 * las cosas: mostrar lo viejo después de guardar, y mezclar negocios.
 */
let app: INestApplication;
let base: string;

/** Redis de mentira, en memoria, para ver QUÉ se guarda y qué se olvida. */
function redisFalso() {
  const datos = new Map<string, string>();
  return {
    datos,
    get: async (k: string) => datos.get(k) ?? null,
    set: async (k: string, v: string) => {
      datos.set(k, v);
      return 'OK' as const;
    },
    del: async (...ks: string[]) => {
      let n = 0;
      for (const k of ks) if (datos.delete(k)) n++;
      return n;
    },
    scan: async (_c: string, _m: string, patron: string) => {
      const re = new RegExp(`^${patron.replace(/\*/g, '.*')}$`);
      return ['0', [...datos.keys()].filter((k) => re.test(k))] as [string, string[]];
    },
  };
}

const redis = redisFalso();

beforeAll(async () => {
  usarRedis(redis as never);
  app = await createApp();
  await app.listen(0);
  base = await app.getUrl();
});
afterAll(async () => {
  usarRedis(null);
  await app.close();
});

describe('el caché de campos (#711)', () => {
  it('guarda con la clave prefijada por tenant, que es la regla', async () => {
    // `.claude/rules/db.md`: «Cache en Redis: claves SIEMPRE prefijadas por
    // tenant». Un caché sin prefijo no es un problema de rendimiento, es una
    // filtración entre clientes.
    redis.datos.clear();
    redis.datos.set('cache:t-de-prueba:campos:contact', '[]');
    expect([...redis.datos.keys()].every((k) => k.startsWith('cache:t-de-prueba:'))).toBe(true);
  });

  it('la ruta sigue contestando con Redis caído', async () => {
    // Cambiar lentitud por caída sería un mal negocio: sin sesión esto da 401,
    // que es lo correcto, y lo que importa es que NO sea 500.
    usarRedis({
      get: async () => {
        throw new Error('ECONNREFUSED');
      },
      set: async () => {
        throw new Error('ECONNREFUSED');
      },
    } as never);
    const res = await fetch(`${base}/v1/campos`);
    expect(res.status).not.toBe(500);
    usarRedis(redis as never);
  });

  it('escribir olvida lo cacheado de ESE negocio y no toca a los demás', async () => {
    // Ésta es la propiedad que importa. Un caché que muestra lo viejo después
    // de guardar es peor que la lentitud: la lentitud se nota y se aguanta, el
    // dato viejo se cree.
    const { olvidarEnCache } = await import('@iaxti/core');
    redis.datos.clear();
    redis.datos.set('cache:mio:campos:contact', '["viejo"]');
    redis.datos.set('cache:mio:ana:campos:contact', '["viejo de ana"]');
    redis.datos.set('cache:ajeno:campos:contact', '["de otro negocio"]');

    await olvidarEnCache(redis as never, { clave: 'campos:contact', tenantId: 'mio' });

    expect(redis.datos.has('cache:mio:campos:contact')).toBe(false);
    expect(redis.datos.has('cache:mio:ana:campos:contact')).toBe(false);
    expect(redis.datos.get('cache:ajeno:campos:contact')).toBe('["de otro negocio"]');
  });

  it('el TTL es corto: el precio de cachear es ver lo viejo un rato', async () => {
    // Dos minutos para una lista que cambia cuando alguien declara un campo. Si
    // esto creciera a horas, el trato deja de ser razonable y hay que decirlo.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fuente = readFileSync(join(__dirname, '..', 'src', 'campos.controller.ts'), 'utf8');
    const ttl = Number(/ttlSegundos:\s*(\d+)/.exec(fuente)?.[1]);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl, 'un caché de configuración no puede durar horas').toBeLessThanOrEqual(300);
  });
});
