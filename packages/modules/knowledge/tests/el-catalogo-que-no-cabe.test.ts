import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { addSource, parseCatalog, processSource } from '../application/sources';

/**
 * Un catálogo que no cabe deja el motivo, y no se lleva la fuente (#1268).
 *
 * `stock` es `int` y la validación miraba solo `Number.isFinite`. Un CSV con
 * `cantidad: 1.5` —cualquier producto que se venda por kilo, metro o litro—
 * pasaba y Postgres levantaba 22P02.
 *
 * Lo caro no era el rechazo: desde esa excepción la transacción queda
 * ABORTADA, así que el `catch` que guarda `status='failed'` moría con 25P02,
 * la excepción escapaba, y el rollback se llevaba hasta la fila de `sources`.
 * El dueño subía su lista de precios, recibía un 500 sin causa, y no quedaba
 * ni el archivo ni la explicación.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let pool: Pool;
let tenant: string;

beforeAll(async () => {
  pool = createPool(URL);
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants(name) VALUES('catalogo que no cabe') RETURNING id")).rows[0].id;
});
afterAll(async () => { await pool?.end(); });

/** Sube un catálogo y lo procesa, como lo hace el controlador. */
async function subir(csv: string) {
  return withTenant(pool, tenant, async (c) => {
    const fuente = await addSource(c, {
      tenantId: tenant,
      kind: 'catalogo',
      name: `lista-${randomUUID().slice(0, 8)}`,
      content: csv,
      requestId: 'prueba',
    });
    return processSource(c, { tenantId: tenant, sourceId: fuente.id, requestId: 'prueba' });
  });
}

describe('el catálogo que no cabe en la columna (#1268)', () => {
  it('una cantidad con decimales no revienta: el producto queda', async () => {
    const r = await subir('nombre,precio,cantidad\nQueso mantecoso,8990,1.5\nJamón,12990,2\n');
    // No se afirma `active`: la indexación necesita el proveedor de
    // embeddings, que en una máquina sin credencial falla — y ESO está bien,
    // deja `failed` con su motivo. Lo que se prueba es que el decimal NO
    // revienta la transacción: la fuente existe, con estado, y el producto
    // quedó guardado.
    expect(r.id).toBeTruthy();
    expect(r.status).not.toBe('processing');
    const p = await pool.query(
      'SELECT name, stock FROM products WHERE tenant_id = $1 AND name = $2',
      [tenant, 'Queso mantecoso'],
    );
    expect(p.rowCount).toBe(1);
    // Se redondea en vez de perderse: «1,5 kilos» es un stock real.
    expect(p.rows[0].stock).toBe(2);
  });

  it('un precio más grande que la columna no se lleva la fuente', async () => {
    const r = await subir('nombre,precio,cantidad\nCasa,9999999999999999,1\n');
    expect(['active', 'failed']).toContain(r.status);
    // Pase lo que pase con ESE producto, la fuente existe y tiene estado.
    const f = await pool.query('SELECT id, status FROM sources WHERE tenant_id = $1 AND id = $2', [tenant, r.id]);
    expect(f.rowCount).toBe(1);
    expect(f.rows[0].status).not.toBe('processing');
  });

  /**
   * La red del savepoint, probada de frente: se fuerza un fallo adentro y se
   * comprueba que el motivo llegó a escribirse. Sin el savepoint este UPDATE
   * muere con 25P02 y la fuente desaparece con el rollback.
   */
  it('si algo revienta adentro, el motivo queda escrito y la fuente también', async () => {
    const r = await withTenant(pool, tenant, async (c) => {
      const fuente = await addSource(c, {
        tenantId: tenant,
        kind: 'url',
        name: 'una url que no existe',
        url: 'https://no-existe.invalido.test/catalogo',
        requestId: 'prueba',
      });
      return processSource(c, { tenantId: tenant, sourceId: fuente.id, requestId: 'prueba' });
    });
    expect(r.status).toBe('failed');
    expect(r.error).toBeTruthy();
    const f = await pool.query('SELECT status, error FROM sources WHERE tenant_id = $1 AND id = $2', [tenant, r.id]);
    expect(f.rowCount).toBe(1);
    expect(f.rows[0].status).toBe('failed');
  });

  it('la validación conoce el dominio de cada columna', () => {
    const filas = parseCatalog('nombre,precio,cantidad\nA,100,1.5\nB,100,999999999999\nC,abc,2\n');
    expect(filas[0].stock).toBe(2);        // redondeado, no perdido
    expect(filas[1].stock).toBeNull();     // más grande que un int de 32 bits
    expect(filas[2].price).toBeNull();     // no es un número
  });
});
