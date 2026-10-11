import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sinTriggers } from '../src/sin-triggers';

/**
 * La propiedad que importa: apagar los triggers para MI sesión y no para la
 * base. `ALTER TABLE … DISABLE TRIGGER` es de la tabla, y con los archivos de
 * prueba corriendo en paralelo contra la misma base, mientras uno limpia el
 * trigger no existe para nadie (#803).
 *
 * Se prueba con una tabla propia y un trigger propio para no depender de las
 * migraciones de ningún módulo: lo que se mide es el alcance del ajuste.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: URL, max: 4 });
  await pool.query(`
    DROP TABLE IF EXISTS prueba_sin_triggers CASCADE;
    CREATE TABLE prueba_sin_triggers (id int primary key);
    CREATE OR REPLACE FUNCTION prueba_sin_triggers_inmutable() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'esta fila es inmutable'; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER prueba_sin_triggers_trg BEFORE DELETE ON prueba_sin_triggers
      FOR EACH ROW EXECUTE FUNCTION prueba_sin_triggers_inmutable();
  `);
});

afterAll(async () => {
  await pool.query('DROP TABLE IF EXISTS prueba_sin_triggers CASCADE');
  await pool.query('DROP FUNCTION IF EXISTS prueba_sin_triggers_inmutable()');
  await pool.end();
});

describe('sinTriggers apaga los triggers de la sesión, no de la tabla (#803)', () => {
  it('el trigger protege por defecto', async () => {
    await pool.query('INSERT INTO prueba_sin_triggers (id) VALUES (1)');
    await expect(pool.query('DELETE FROM prueba_sin_triggers WHERE id = 1')).rejects.toThrow(
      /inmutable/,
    );
  });

  it('adentro se puede limpiar, y AFUERA el trigger sigue protegiendo al mismo tiempo', async () => {
    await pool.query('INSERT INTO prueba_sin_triggers (id) VALUES (2), (3)');

    // La aserción de verdad: mientras la ventana está abierta, otra conexión
    // del mismo pool todavía recibe el rechazo. Con `ALTER TABLE … DISABLE`
    // esta línea de abajo borraba la fila y no fallaba.
    await sinTriggers(pool, async (c) => {
      await c.query('DELETE FROM prueba_sin_triggers WHERE id = 2');
      await expect(pool.query('DELETE FROM prueba_sin_triggers WHERE id = 3')).rejects.toThrow(
        /inmutable/,
      );
    });

    const quedan = await pool.query('SELECT id FROM prueba_sin_triggers ORDER BY id');
    expect(quedan.rows.map((f) => f.id)).toEqual([1, 3]);
  });

  it('al salir, la sesión queda como estaba: ninguna conexión vuelve al pool sin triggers', async () => {
    await sinTriggers(pool, (c) => c.query('SELECT 1'));
    // Cuatro intentos para agarrar la conexión que se usó adentro, cualquiera
    // que sea la que el pool entregue.
    for (let i = 0; i < 4; i++) {
      await expect(pool.query('DELETE FROM prueba_sin_triggers WHERE id = 3')).rejects.toThrow(
        /inmutable/,
      );
    }
  });

  it('si la limpieza falla, el error sale y la conexión no vuelve envenenada', async () => {
    await expect(
      sinTriggers(pool, async () => {
        throw new Error('se cayó la limpieza');
      }),
    ).rejects.toThrow('se cayó la limpieza');
    for (let i = 0; i < 4; i++) {
      await expect(pool.query('DELETE FROM prueba_sin_triggers WHERE id = 3')).rejects.toThrow(
        /inmutable/,
      );
    }
  });
});
