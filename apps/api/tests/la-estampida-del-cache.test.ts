import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { dbPlatformAdminResolver, dbRoleResolver } from '../src/auth/role-resolver';

/**
 * Las llamadas simultáneas se juntan en una sola consulta (#673).
 *
 * Sentry, staging: **siete errores en el mismo segundo**, todos
 * «timeout exceeded when trying to connect» desde `role-resolver`. Era el panel
 * de SuperAdmin cargando: abre siete pedidos a la vez, los siete preguntan «¿es
 * admin de plataforma?» por el MISMO usuario, y con el cache frío los siete van
 * a la base.
 *
 * El pool tiene seis conexiones. Y cada pedido necesita otra para su propio
 * trabajo, así que siete pedidos querían hasta catorce de seis.
 *
 * El cache de 60 s ya estaba y no alcanzaba, porque se llenaba DESPUÉS de que la
 * consulta volviera. Lo que faltaba era guardar la promesa antes de esperarla.
 */

/** Un pool de mentira que cuenta cuántas conexiones se pidieron. */
function poolContador(respuesta: unknown, demoraMs = 30) {
  const estado = { conexiones: 0, maximoSimultaneo: 0, abiertas: 0 };
  const cliente = {
    query: async () => {
      await new Promise((r) => setTimeout(r, demoraMs));
      return { rows: [respuesta], rowCount: 1 };
    },
    release: () => {
      estado.abiertas--;
    },
  } as unknown as PoolClient;
  const pool = {
    connect: async () => {
      estado.conexiones++;
      estado.abiertas++;
      estado.maximoSimultaneo = Math.max(estado.maximoSimultaneo, estado.abiertas);
      return cliente;
    },
    query: async () => {
      await new Promise((r) => setTimeout(r, demoraMs));
      return { rows: [respuesta], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, estado };
}

describe('la estampida del cache (#673)', () => {
  it('siete llamadas simultáneas del mismo usuario hacen UNA consulta', async () => {
    const { pool, estado } = poolContador({ user_id: 'u1' });
    const resolver = dbPlatformAdminResolver(pool);

    // Las siete salen JUNTAS, sin await entre medio: así llegan todas con el
    // cache frío, que es exactamente lo que pasaba al abrir el panel.
    const todas = await Promise.all(Array.from({ length: 7 }, () => resolver('usuario-1')));

    expect(estado.conexiones, 'cada llamada tomó su propia conexión').toBe(1);
    expect(estado.maximoSimultaneo).toBe(1);
    // Y todas reciben la misma respuesta.
    expect(new Set(todas).size).toBe(1);
  });

  it('las siguientes salen del cache, sin tocar la base', async () => {
    const { pool, estado } = poolContador({ user_id: 'u1' });
    const resolver = dbPlatformAdminResolver(pool);
    await resolver('usuario-1');
    await resolver('usuario-1');
    await resolver('usuario-1');
    expect(estado.conexiones).toBe(1);
  });

  it('usuarios distintos NO se comparten: sería peor que la estampida', async () => {
    const { pool, estado } = poolContador({ user_id: 'u1' });
    const resolver = dbPlatformAdminResolver(pool);
    await Promise.all([resolver('usuario-1'), resolver('usuario-2')]);
    expect(estado.conexiones).toBe(2);
  });

  it('un fallo NO queda cacheado: el siguiente reintenta', async () => {
    let intentos = 0;
    const pool = {
      connect: async () => {
        intentos++;
        if (intentos === 1) throw new Error('timeout exceeded when trying to connect');
        return {
          query: async () => ({ rows: [{ user_id: 'u1' }], rowCount: 1 }),
          release: () => {},
        } as unknown as PoolClient;
      },
    } as unknown as Pool;
    const resolver = dbPlatformAdminResolver(pool);

    await expect(resolver('usuario-1')).rejects.toThrow(/timeout/);
    // Sin borrar la entrada, este seguiría fallando durante SESENTA segundos —
    // un error cacheado es peor que la estampida que se vino a arreglar.
    await expect(resolver('usuario-1')).resolves.toBeDefined();
    expect(intentos).toBe(2);
  });

  it('el resolutor de roles hace lo mismo', async () => {
    const { pool, estado } = poolContador({ role: 'ADMIN' });
    const resolver = dbRoleResolver(pool);
    const tenant = '11111111-2222-3333-4444-555555555555';
    await Promise.all(Array.from({ length: 5 }, () => resolver(tenant, 'usuario-1')));
    // `withTenant` toma una conexión por corrida: con la estampida serían cinco.
    expect(estado.conexiones).toBe(1);
  });

  it('un tenant que no es uuid sigue sin tocar la base', async () => {
    const { pool, estado } = poolContador({ role: 'ADMIN' });
    const resolver = dbRoleResolver(pool);
    expect(await resolver('no-es-uuid', 'usuario-1')).toBeNull();
    expect(estado.conexiones).toBe(0);
  });
});
