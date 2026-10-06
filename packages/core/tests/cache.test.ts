import { describe, expect, it, vi } from 'vitest';
import { claveDeCache, leerConCache, olvidarEnCache } from '../src/cache';

/**
 * El caché de lecturas (#711).
 *
 * Existe por una medición, no por una corazonada: desde dentro del VPS,
 * **postgres 64 ms** por consulta y **redis 0 ms**. La base es Supabase y está
 * lejos; Redis está al lado. Abrir una conversación son 21 peticiones.
 *
 * Lo que estas pruebas cuidan NO es la velocidad —eso se mide aparte— sino las
 * tres formas en que un caché hace daño: filtrar entre clientes, filtrar entre
 * usuarios del mismo cliente, y mostrar lo viejo después de guardar.
 */

/** Un Redis de mentira que guarda en un Map y cuenta lo que le piden. */
function redisFalso() {
  const datos = new Map<string, string>();
  return {
    datos,
    get: vi.fn(async (k: string) => datos.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      datos.set(k, v);
      return 'OK' as const;
    }),
    del: vi.fn(async (...ks: string[]) => {
      let n = 0;
      for (const k of ks) if (datos.delete(k)) n++;
      return n;
    }),
    scan: vi.fn(async (_c: string, _m: string, patron: string) => {
      const re = new RegExp(`^${patron.replace(/\*/g, '.*')}$`);
      return ['0', [...datos.keys()].filter((k) => re.test(k))] as [string, string[]];
    }),
  };
}

describe('la clave lleva el tenant, siempre', () => {
  it('sin actor, el valor es del negocio entero', () => {
    expect(claveDeCache({ clave: 'campos', tenantId: 't1', ttlSegundos: 30 })).toBe('cache:t1:campos');
  });

  it('con actor, el valor es de esa persona', () => {
    // Si la respuesta depende del permiso de quien pregunta y el actor NO entra
    // en la clave, alguien sin permiso ve lo que cacheó un administrador.
    expect(claveDeCache({ clave: 'acceso', tenantId: 't1', actorId: 'u9', ttlSegundos: 30 })).toBe(
      'cache:t1:u9:acceso',
    );
  });
});

describe('leerConCache', () => {
  it('la primera vez va a la base; la segunda no', async () => {
    const redis = redisFalso();
    const traer = vi.fn(async () => ({ campos: ['rut'] }));
    const o = { clave: 'campos', tenantId: 't1', ttlSegundos: 30 };
    expect(await leerConCache(redis, o, traer)).toEqual({ campos: ['rut'] });
    expect(await leerConCache(redis, o, traer)).toEqual({ campos: ['rut'] });
    expect(traer, 'la segunda tiene que salir del caché').toHaveBeenCalledTimes(1);
  });

  it('el tenant A NUNCA ve lo del tenant B', async () => {
    // Ésta es la propiedad que importa. Un caché sin prefijo no es un bug de
    // rendimiento: es una filtración entre clientes.
    const redis = redisFalso();
    await leerConCache(redis, { clave: 'campos', tenantId: 'A', ttlSegundos: 30 }, async () => 'de A');
    const deB = await leerConCache(
      redis,
      { clave: 'campos', tenantId: 'B', ttlSegundos: 30 },
      async () => 'de B',
    );
    expect(deB).toBe('de B');
    expect(redis.datos.get('cache:A:campos')).toBe('"de A"');
  });

  it('dos personas del mismo negocio no comparten lo que depende de su permiso', async () => {
    const redis = redisFalso();
    const base = { clave: 'acceso', tenantId: 't1', ttlSegundos: 30 };
    await leerConCache(redis, { ...base, actorId: 'admin' }, async () => ['todo']);
    const comoUsuario = await leerConCache(redis, { ...base, actorId: 'usuario' }, async () => ['poco']);
    expect(comoUsuario).toEqual(['poco']);
  });

  it('guarda con vencimiento, no para siempre', async () => {
    const redis = redisFalso();
    await leerConCache(redis, { clave: 'tags', tenantId: 't1', ttlSegundos: 45 }, async () => []);
    expect(redis.set).toHaveBeenCalledWith('cache:t1:tags', '[]', 'EX', 45);
  });

  it('si Redis se cae, se contesta igual desde la base', async () => {
    // Cambiar lentitud por caída sería un mal negocio.
    const roto = {
      get: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      set: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
    };
    expect(
      await leerConCache(roto, { clave: 'campos', tenantId: 't1', ttlSegundos: 30 }, async () => 'de la base'),
    ).toBe('de la base');
  });

  it('sin Redis configurado, funciona igual y no cachea nada', async () => {
    const traer = vi.fn(async () => 1);
    expect(await leerConCache(null, { clave: 'x', tenantId: 't1', ttlSegundos: 30 }, traer)).toBe(1);
    expect(await leerConCache(null, { clave: 'x', tenantId: 't1', ttlSegundos: 30 }, traer)).toBe(1);
    expect(traer).toHaveBeenCalledTimes(2);
  });

  it('un valor nulo guardado se devuelve, no se vuelve a pedir', async () => {
    // `null` es una respuesta válida —no hay sugerencia, no hay ficha— y
    // tratarla como «no está en el caché» haría que lo más barato de cachear
    // fuera justo lo que nunca se cachea.
    const redis = redisFalso();
    const traer = vi.fn(async () => null);
    const o = { clave: 'sugerencia', tenantId: 't1', ttlSegundos: 30 };
    await leerConCache(redis, o, traer);
    await leerConCache(redis, o, traer);
    expect(traer).toHaveBeenCalledTimes(1);
  });
});

describe('olvidarEnCache', () => {
  it('lo que se escribe borra lo suyo, incluidas las copias por persona', async () => {
    // Un caché que muestra lo viejo después de guardar es peor que la lentitud
    // que vino a arreglar: la lentitud se nota y se aguanta, el dato viejo se cree.
    const redis = redisFalso();
    redis.datos.set('cache:t1:campos', '"viejo"');
    redis.datos.set('cache:t1:ana:campos', '"viejo de ana"');
    redis.datos.set('cache:t1:beto:campos', '"viejo de beto"');
    redis.datos.set('cache:t2:campos', '"de otro negocio"');

    await olvidarEnCache(redis as never, { clave: 'campos', tenantId: 't1' });

    expect(redis.datos.has('cache:t1:campos')).toBe(false);
    expect(redis.datos.has('cache:t1:ana:campos')).toBe(false);
    expect(redis.datos.has('cache:t1:beto:campos')).toBe(false);
    expect(redis.datos.get('cache:t2:campos'), 'el otro negocio no se toca').toBe('"de otro negocio"');
  });

  it('usa scan y no keys', async () => {
    // `keys` bloquea Redis entero mientras recorre, y acá Redis es lo único que
    // está rápido.
    const redis = redisFalso();
    await olvidarEnCache(redis as never, { clave: 'tags', tenantId: 't1' });
    expect(redis.scan).toHaveBeenCalled();
  });

  it('si no se pudo olvidar, no revienta: vence solo', async () => {
    const roto = {
      del: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      scan: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
    };
    await expect(olvidarEnCache(roto, { clave: 'campos', tenantId: 't1' })).resolves.toBeUndefined();
  });
});
