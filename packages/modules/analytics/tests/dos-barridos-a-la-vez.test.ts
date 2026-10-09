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
 * ## Lo que costó dos intentos entender
 *
 * Esta prueba, sola, pasaba: pedirle al mismo pool dos barridos a la vez no
 * alcanzaba para solapar los `INSERT`. Con eso di por falsa la hipótesis de la
 * carrera y arreglé lo que sí era verdad —que el `ON CONFLICT` nombraba un
 * índice mientras existía otra única encima—, moviendo el árbitro a la única de
 * `conversation_id`.
 *
 * **El rojo cambió de nombre y no se fue**: pasó de
 * `response_samples_conversation_id_key` a `response_samples_pkey`. Y eso lo
 * explicó todo: `ON CONFLICT` protege UN índice —inserción especulativa en el
 * que se le nombra— y en los demás únicos no hay nada, así que la única que no
 * es árbitro es la que lanza. Con dos únicas que se pisan, las dos
 * orientaciones estaban rotas.
 *
 * El arreglo de verdad es que quede **una sola** (migración 0004): la de
 * `conversation_id` era redundante —los ids de conversación son únicos en toda
 * la base y la muestra copia el tenant de SU conversación— y a cambio rompía la
 * idempotencia que el barrido necesita.
 *
 * La prueba que lo cazó fue la corrida completa del paquete, donde vitest corre
 * los archivos en paralelo y dos barridos se solapan de verdad. Esta de acá
 * sigue, porque es la que deja el caso escrito y la que impide que alguien
 * "mejore" el `ON CONFLICT` de vuelta.
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
