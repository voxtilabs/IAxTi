import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import { sweepResponseSamples } from '../application/aggregate';

/**
 * A quién visita el barrido de muestras (#738, ADR-0026).
 *
 * Recorría TODOS los tenants vivos, abriendo una transacción por cada uno para
 * un `INSERT … SELECT` que casi nunca inserta nada. Medido el 09/10 con 1.283
 * tenants: 4,5 ms cada uno, ~5,8 s el barrido entero — y éste es HORARIO, así
 * que se paga veinticuatro veces al día.
 *
 * Lo que estas pruebas cuidan es la propiedad que hace seguro el filtro: **que
 * no se pierda una muestra**. Un barrido que visita menos y deja al dueño sin
 * sus percentiles es peor que uno lento, porque el número falta sin avisar.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
const tenants: string[] = [];

/** Un tenant con una conversación respondida hace `horas`, o sin ninguna. */
async function tenantConRespuesta(horas: number | null): Promise<string> {
  const id = (
    await admin.query("INSERT INTO tenants (name) VALUES ('muestras-filtro') RETURNING id")
  ).rows[0].id;
  tenants.push(id);
  if (horas === null) return id;
  const contacto = (
    await admin.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin)
       VALUES ($1, 'Rocío', $2, 'whatsapp') RETURNING id`,
      [id, `+5699${Math.floor(Math.random() * 10_000_000)}`],
    )
  ).rows[0].id;
  await admin.query(
    `INSERT INTO conversations (tenant_id, contact_id, channel, owner_id, created_at, first_response_at)
     VALUES ($1, $2, 'whatsapp', $3, now() - make_interval(hours => $4 + 1),
             now() - make_interval(hours => $4))`,
    [id, contacto, randomUUID(), horas],
  );
  return id;
}

const visitados = async (): Promise<string[]> =>
  (await admin.query('SELECT tenant_id FROM tenants_con_muestras_por_tomar()')).rows.map(
    (f) => f.tenant_id as string,
  );

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
});

afterAll(async () => {
  for (const t of tenants) {
    for (const tabla of ['response_samples', 'conversations', 'contacts', 'outbox']) {
      await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [t]);
    }
  }
  await admin.end();
});

describe('a quién visita el barrido de muestras (#738)', () => {
  it('con una conversación respondida en la ventana, el tenant entra', async () => {
    const id = await tenantConRespuesta(2);
    expect(await visitados()).toContain(id);
  });

  it('a 25 horas todavía entra: la ventana es de 26', async () => {
    const id = await tenantConRespuesta(25);
    expect(await visitados()).toContain(id);
  });

  it('a 30 horas ya no: esa muestra se tomó en la pasada anterior', async () => {
    const id = await tenantConRespuesta(30);
    expect(await visitados()).not.toContain(id);
  });

  it('sin ninguna conversación respondida, no entra. Es el 99 %', async () => {
    const id = await tenantConRespuesta(null);
    expect(await visitados()).not.toContain(id);
  });

  it('un tenant borrado no entra, aunque tenga respuestas frescas', async () => {
    const id = await tenantConRespuesta(1);
    await admin.query("UPDATE tenants SET state = 'deleted' WHERE id = $1", [id]);
    expect(await visitados()).not.toContain(id);
  });

  it('la función devuelve SOLO ids', async () => {
    const r = await admin.query('SELECT * FROM tenants_con_muestras_por_tomar() LIMIT 1');
    expect(r.fields.map((f) => f.name)).toEqual(['tenant_id']);
  });

  it('no repite al que tiene varias conversaciones respondidas', async () => {
    // `DISTINCT`: sin eso, un negocio con cien conversaciones del día se
    // visitaría cien veces y el filtro empeoraría justo lo que vino a mejorar.
    const id = await tenantConRespuesta(1);
    const contacto = (
      await admin.query(
        `INSERT INTO contacts (tenant_id, name, phone, origin)
         VALUES ($1, 'Otro', $2, 'whatsapp') RETURNING id`,
        [id, `+5699${Math.floor(Math.random() * 10_000_000)}`],
      )
    ).rows[0].id;
    await admin.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel, owner_id, created_at, first_response_at)
       VALUES ($1, $2, 'whatsapp', $3, now() - interval '3 hours', now() - interval '2 hours')`,
      [id, contacto, randomUUID()],
    );
    const lista = await visitados();
    expect(lista.filter((t) => t === id)).toHaveLength(1);
  });

  it('y el barrido sigue tomando la muestra que hay que tomar', async () => {
    // Visitar menos no puede significar medir menos: si la muestra falta, el
    // dueño se queda sin percentiles y no hay ningún error que lo diga.
    const id = await tenantConRespuesta(1);
    const tomadas = await sweepResponseSamples(admin);
    expect(tomadas).toBeGreaterThan(0);
    const mias = await admin.query(
      'SELECT count(*)::int AS n FROM response_samples WHERE tenant_id = $1',
      [id],
    );
    expect(mias.rows[0].n).toBeGreaterThan(0);
  }, 30_000);
});
