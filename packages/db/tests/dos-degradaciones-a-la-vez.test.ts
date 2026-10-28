import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/client';
import { degradarSinRomper } from '../src/degradar-sin-romper';

/**
 * Dos degradaciones intercaladas sobre el MISMO cliente (#991).
 *
 * El nombre del savepoint era fijo, y el comentario decía que estaba bien
 * «porque esta función libera el suyo antes de devolver, el anidamiento queda
 * en orden». Eso vale cuando las llamadas están una DESPUÉS de la otra. No vale
 * cuando se intercalan, y en este repo se intercalan: `copilot.ts` tenía cuatro
 * lecturas opcionales dentro de un `Promise.all` sobre el mismo `PoolClient`
 * (#966). Ahí las quité del `Promise.all`, pero el peligro queda para el
 * próximo que lo escriba, y no hay nada que lo avise.
 *
 * Lo que pasa con el nombre fijo, paso a paso:
 *
 *   A: SAVEPOINT p          -- queda uno
 *   B: SAVEPOINT p          -- el nuevo TAPA al de A
 *   A: falla -> ROLLBACK TO p   -- vuelve al de B, no al suyo
 *   B: RELEASE SAVEPOINT p
 *   B: RELEASE SAVEPOINT p  -> «no such savepoint»
 *
 * O sea: A deshace trabajo que no era suyo y B revienta con un error que no
 * habla de nada de esto. Con nombres propios por llamada, cada una vuelve a lo
 * suyo y la otra no se entera.
 */
let pool: Pool;
let cliente: PoolClient;

beforeAll(async () => {
  pool = createPool();
  cliente = await pool.connect();
  await cliente.query('CREATE TEMP TABLE dos_a_la_vez (quien text)');
});
afterAll(async () => {
  cliente.release();
  await pool.end();
});

it('la segunda se niega, con el arreglo en el mensaje', async () => {
  await cliente.query('BEGIN');
  await cliente.query("INSERT INTO dos_a_la_vez VALUES ('antes')");

  let empezoLaPrimera: () => void = () => {};
  const esperarQueEmpiece = new Promise<void>((r) => {
    empezoLaPrimera = r;
  });

  const primera = degradarSinRomper(
    cliente,
    async (c) => {
      await c.query("INSERT INTO dos_a_la_vez VALUES ('de A')");
      empezoLaPrimera();
      await new Promise((r) => setTimeout(r, 40));
      return 'A salió bien';
    },
    () => 'A degradó',
  );

  await esperarQueEmpiece;
  // La segunda, con la primera todavía en vuelo sobre el MISMO cliente.
  await expect(
    degradarSinRomper(
      cliente,
      async (c) => {
        await c.query("INSERT INTO dos_a_la_vez VALUES ('de B')");
        return 'B salió bien';
      },
      () => 'B degradó',
    ),
  ).rejects.toThrow(/en vuelo sobre este cliente[\s\S]*EN SERIE/);

  await expect(primera).resolves.toBe('A salió bien');
  const filas = await cliente.query('SELECT quien FROM dos_a_la_vez ORDER BY quien');
  expect(filas.rows.map((f) => f.quien)).toEqual(['antes', 'de A']);
  await cliente.query('ROLLBACK');
});

it('y en serie funcionan las dos, que es la forma que sí sirve', async () => {
  await cliente.query('BEGIN');
  const uno = await degradarSinRomper(
    cliente,
    async (c) => {
      await c.query("INSERT INTO dos_a_la_vez VALUES ('serie 1')");
      await c.query('SELECT 1 FROM tabla_que_no_existe');
      return 'no debería';
    },
    () => 'la primera degradó',
  );
  const dos = await degradarSinRomper(
    cliente,
    async (c) => {
      await c.query("INSERT INTO dos_a_la_vez VALUES ('serie 2')");
      return 'la segunda salió bien';
    },
    () => 'la segunda degradó',
  );
  expect([uno, dos]).toEqual(['la primera degradó', 'la segunda salió bien']);
  // Lo de la primera se fue en SU rollback; lo de la segunda quedó. Que es
  // todo lo que se le pide a esto.
  const filas = await cliente.query("SELECT quien FROM dos_a_la_vez WHERE quien LIKE 'serie%' ORDER BY quien");
  expect(filas.rows.map((f) => f.quien)).toEqual(['serie 2']);
  await cliente.query('ROLLBACK');
});

it('un alFallar que tira no deja el cliente marcado para siempre', async () => {
  // Sin el `finally`, esto dejaba la conexión inutilizable para la próxima
  // lectura opcional, con un mensaje que ahí sería mentira.
  await cliente.query('BEGIN');
  await expect(
    degradarSinRomper(
      cliente,
      async (c) => {
        await c.query('SELECT 1 FROM tabla_que_no_existe');
        return 0;
      },
      () => {
        throw new Error('el alFallar también falló');
      },
    ),
  ).rejects.toThrow('el alFallar también falló');
  // Y la conexión sigue sirviendo.
  await expect(
    degradarSinRomper(cliente, async () => 'sigo pudiendo', () => 'degradé'),
  ).resolves.toBe('sigo pudiendo');
  await cliente.query('ROLLBACK');
});

/**
 * Y el otro lado: sobre un POOL la vigilancia estorba (#1099).
 *
 * La marca de «en vuelo» es del objeto que llega. Cuando ese objeto es el pool,
 * queda puesta sobre el pool entero y dos peticiones simultáneas chocan — con el
 * mensaje de arriba, que ahí es mentira.
 *
 * Es mentira siempre, no a veces: con un pool cada consulta sale por su propia
 * conexión, Postgres rechaza el `SAVEPOINT` —`can only be used in transaction
 * blocks`— y nunca se abre un punto. No hay pila que pisar.
 *
 * Dónde dolía: `apps/api/src/main.ts` resuelve el acceso al módulo con
 * `modulosDelPlan(pool, …)` en CADA request, así que con dos peticiones a la vez
 * una se caía con 500 dentro del guard. Se destapó midiendo #945: el e2e de
 * bandeja pasó 4/4 en una corrida y se cayó en la siguiente, con el mismo
 * código de aplicación. Un 500 intermitente en un guard se lee como e2e flaky,
 * que es la forma más cara de que algo esté roto.
 */
it('varias degradaciones a la vez sobre el POOL salen todas bien', async () => {
  const leer = (n: number) =>
    degradarSinRomper(
      pool,
      async (c) => (await c.query('SELECT $1::int AS n', [n])).rows[0].n as number,
      () => -n,
    );

  // Seis a la vez contra un pool con menos conexiones que eso: las que esperan
  // turno también tienen que salir bien.
  expect(await Promise.all([1, 2, 3, 4, 5, 6].map(leer))).toEqual([1, 2, 3, 4, 5, 6]);

  // Y el camino de la degradación sigue degradando, no rompiendo.
  const caida = (n: number) =>
    degradarSinRomper(
      pool,
      async (c) => {
        await c.query('SELECT 1 FROM tabla_que_no_existe');
        return n;
      },
      () => -n,
    );
  expect(await Promise.all([caida(1), caida(2), caida(3)])).toEqual([-1, -2, -3]);
});

it('sobre un pool nunca se abre un savepoint, que es por qué no hay nada que vigilar', async () => {
  // La pregunta que la función se hace internamente, hecha de frente: si esto
  // dejara de ser cierto —un pool que sí abre transacción— la excepción de
  // arriba habría que revisarla, y esta prueba es la que lo avisaría.
  await expect(pool.query('SAVEPOINT prueba_1099')).rejects.toThrow(/transaction block/i);
});
