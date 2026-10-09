import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import { sweepResponseSamples } from '../application/aggregate';

/**
 * Dos barridos de muestras a la vez (#748).
 *
 * El `INSERT … SELECT` del barrido termina en `ON CONFLICT (tenant_id,
 * conversation_id) DO NOTHING`, y eso parecía suficiente. No lo era:
 * `response_samples` tiene DOS restricciones únicas —la clave primaria compuesta
 * y una sobre `conversation_id` sola— y `ON CONFLICT` solo maneja el choque del
 * índice que se le nombra. Un choque en cualquier otra única **lanza**.
 *
 * Apareció como un rojo intermitente en la corrida completa:
 *
 *     duplicate key value violates unique constraint
 *     "response_samples_conversation_id_key"
 *
 * ## Lo que estas pruebas NO demuestran
 *
 * La primera hipótesis fue que dos barridos solapados se pisaban. **Es falsa, y
 * esta prueba es la que lo muestra**: la inserción especulativa del árbitro
 * compuesto maneja bien ese caso —medido también con dos transacciones
 * solapadas a mano— y por eso esta prueba pasaba ANTES del arreglo.
 *
 * Se queda igual, y no por costumbre: es la que impide que el arreglo se
 * "arregle" de vuelta rompiendo la concurrencia, y la que documenta en qué
 * quedó la hipótesis. Una prueba que pasa antes y después no prueba el arreglo;
 * acota lo que el arreglo no puede romper.
 *
 * Lo que el arreglo sí cambia es cuál índice absorbe el choque: con la
 * compuesta como árbitro, un choque en la única de `conversation_id` lanzaba.
 * Qué escribió la fila cruzada que lo provocó sigue sin explicación, y está
 * anotado en el issue en vez de dado por entendido.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('barridos-748') RETURNING id"))
    .rows[0].id;
  const contacto = (
    await admin.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin)
       VALUES ($1, 'Rocío', $2, 'whatsapp') RETURNING id`,
      [tenant, `+5697${Math.floor(Math.random() * 10_000_000)}`],
    )
  ).rows[0].id;
  await admin.query(
    `INSERT INTO conversations (tenant_id, contact_id, channel, owner_id, created_at, first_response_at)
     VALUES ($1, $2, 'whatsapp', $3, now() - interval '2 hours', now() - interval '1 hour')`,
    [tenant, contacto, randomUUID()],
  );
});

afterAll(async () => {
  for (const tabla of ['response_samples', 'conversations', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('dos barridos solapados (#748)', () => {
  it('no se caen, y la muestra queda una sola vez', async () => {
    // A propósito y no por el paralelismo de vitest: dos corridas solapadas es
    // lo que hace un segundo worker, y el defecto solo se ve así.
    const [a, b] = await Promise.allSettled([
      sweepResponseSamples(admin),
      sweepResponseSamples(admin),
    ]);
    const caido = [a, b].find((r) => r.status === 'rejected');
    expect(
      caido && 'reason' in caido ? String(caido.reason) : null,
      'un barrido solapado se cayó en vez de no hacer nada',
    ).toBeNull();

    // Y la propiedad que importa sigue en pie: la muestra se tomó, una vez.
    const mias = await admin.query(
      'SELECT count(*)::int AS n FROM response_samples WHERE tenant_id = $1',
      [tenant],
    );
    expect(mias.rows[0].n).toBe(1);
  }, 30_000);

  it('y un barrido que vuelve a pasar tampoco inserta de nuevo', async () => {
    await sweepResponseSamples(admin);
    const mias = await admin.query(
      'SELECT count(*)::int AS n FROM response_samples WHERE tenant_id = $1',
      [tenant],
    );
    expect(mias.rows[0].n).toBe(1);
  }, 30_000);
});
