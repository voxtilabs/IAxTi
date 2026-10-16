import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/client';
import { runMigrations } from '../src/migrate';
import { withTenant } from '../src/tenant';
import { degradarSinRomper } from '../src/degradar-sin-romper';

/**
 * Una lectura opcional que falla no puede dejar abortada la transacción de
 * quien llamó (#962).
 *
 * El `.catch(() => null)` sobre una consulta parece inofensivo y no lo es:
 * en Postgres la sentencia fallida aborta el bloque entero, y como estas
 * funciones reciben el cliente del llamador, lo que se rompe es su
 * transacción. El síntoma llega lejos de la causa —`current transaction is
 * aborted`— y no nombra ni la tabla ni el permiso que faltaba.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('degradar-962') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

/**
 * Una lectura que siempre se cae. `Promise<never>` a propósito: así el tipo de
 * lo que devuelve `degradarSinRomper` lo fija el que degrada, que es como se
 * usa de verdad.
 */
const falla = async (c: PoolClient): Promise<never> => {
  await c.query('SELECT * FROM tabla_que_no_existe_962');
  throw new Error('inalcanzable: la consulta de arriba ya falló');
};

describe('degradarSinRomper', () => {
  it('devuelve lo leído cuando la lectura anda', async () => {
    const zona = await withTenant(admin, tenant, (c) =>
      degradarSinRomper(
        c,
        async (cl) => (await cl.query('SELECT 42 AS n')).rows[0].n as number,
        () => -1,
      ),
    );
    expect(zona).toBe(42);
  });

  it('cuando falla, degrada Y la transacción del llamador sigue viva', async () => {
    const r = await withTenant(admin, tenant, async (c) => {
      const valor = await degradarSinRomper(c, falla, () => 'degradado');
      // Esto es lo que se rompía: con un `.catch()` acá llegaba
      // `current transaction is aborted, commands ignored until end of
      // transaction block`.
      const sigue = await c.query('SELECT 1 AS vivo');
      return { valor, vivo: sigue.rows[0].vivo };
    });
    expect(r).toEqual({ valor: 'degradado', vivo: 1 });
  });

  it('lo que la transacción ya había escrito antes del fallo se conserva', async () => {
    // El savepoint se abre JUSTO antes de la lectura opcional: volver a él no
    // puede deshacer el trabajo de verdad del llamador.
    await withTenant(admin, tenant, async (c) => {
      await c.query("UPDATE tenants SET name = 'degradar-962-editado' WHERE id = $1", [tenant]);
      await degradarSinRomper(c, falla, () => null);
    });
    const n = await admin.query('SELECT name FROM tenants WHERE id = $1', [tenant]);
    expect(n.rows[0].name).toBe('degradar-962-editado');
  });

  it('el que degrada recibe el error de verdad, no un null pelado', async () => {
    let visto = '';
    await withTenant(admin, tenant, (c) =>
      degradarSinRomper(c, falla, (e) => {
        visto = e.message;
        return null;
      }),
    );
    // Sin esto, degradar es esconder: nadie se entera de qué hay que arreglar.
    expect(visto).toMatch(/tabla_que_no_existe_962/);
  });

  it('fuera de una transacción también degrada, sin pedir savepoints', async () => {
    // Suelto no hay nada que proteger —una sentencia que falla no arrastra a
    // las siguientes— y `SAVEPOINT` ahí lanza `25P01`. La función no puede
    // caerse por eso.
    const c = await admin.connect();
    try {
      const valor = await degradarSinRomper(c, falla, () => 'degradado');
      expect(valor).toBe('degradado');
      expect((await c.query('SELECT 7 AS n')).rows[0].n).toBe(7);
    } finally {
      c.release();
    }
  });
});
