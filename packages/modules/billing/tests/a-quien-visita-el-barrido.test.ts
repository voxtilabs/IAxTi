import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { ensureSubscription, sweepBilling } from '../application/billing';

/**
 * El barrido pregunta a quién visitar (#580, ADR-0026).
 *
 * `sweepBilling` recorría TODOS los tenants vivos, uno por uno, abriendo una
 * transacción y corriendo los seis pasos. Medido el 09/10 en una base con 1.232
 * tenants: visitar uno SIN trabajo cuesta 4,5 ms, así que el barrido entero eran
 * ~5,5 s. Proyectado a mil tenants con la base a 64 ms de distancia (#711):
 * **diez minutos de un cron haciendo nada**. Preguntar una vez: 2 ms.
 *
 * El síntoma visible era otro —cuatro pruebas de esta suite rojas en local y
 * verdes en CI— y el timeout era el mensajero, no el problema.
 *
 * Lo que estas pruebas cuidan es la propiedad que hace seguro el filtro: **que
 * no se pierda trabajo**. Un barrido que visita menos y deja a un tenant sin
 * suspender es peor que uno lento.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
const tenants: string[] = [];

async function nuevoTenant(nombre: string, extra = ''): Promise<string> {
  const r = await admin.query(
    `INSERT INTO tenants (name, plan, state${extra ? ', ' + extra.split('=')[0].trim() : ''})
     VALUES ($1, 'base', 'active'${extra ? ', ' + extra.split('=')[1].trim() : ''}) RETURNING id`,
    [nombre],
  );
  tenants.push(r.rows[0].id);
  return r.rows[0].id;
}

const conTrabajo = async (): Promise<string[]> =>
  (await admin.query('SELECT tenant_id FROM tenants_con_trabajo_de_facturacion()')).rows.map(
    (f) => f.tenant_id as string,
  );

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
});

afterAll(async () => {
  for (const t of tenants) {
    for (const tabla of ['invoices', 'subscriptions', 'outbox']) {
      await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [t]);
    }
  }
  await admin.end();
});

describe('a quién visita el barrido (#580)', () => {
  it('un tenant activo sin nada pendiente NO entra en la lista', async () => {
    // Éste es el 99 % en producción, y es el que costaba 4,5 ms cada vez.
    const id = await nuevoTenant('sin-trabajo');
    await withTenant(admin, id, (c) => ensureSubscription(c, id));
    // La suscripción nace con el próximo cobro en el futuro.
    await admin.query(
      "UPDATE subscriptions SET next_charge_at = (now() + interval '20 days')::date WHERE tenant_id = $1",
      [id],
    );
    expect(await conTrabajo()).not.toContain(id);
  });

  it('con el ciclo vencido SÍ entra: hay que emitir', async () => {
    const id = await nuevoTenant('ciclo-vencido');
    await withTenant(admin, id, (c) => ensureSubscription(c, id));
    await admin.query(
      "UPDATE subscriptions SET next_charge_at = (now() - interval '1 day')::date WHERE tenant_id = $1",
      [id],
    );
    expect(await conTrabajo()).toContain(id);
  });

  it('con una factura por cobrar SÍ entra, aunque el plazo no se haya cumplido', async () => {
    // El filtro decide a quién mirar; el PASO decide si ya venció. Duplicar los
    // días de gracia en la función los pondría en dos lugares, y el día que
    // cambien uno quedaría viejo: un tenant dejaría de visitarse y su
    // suspensión no llegaría nunca.
    const id = await nuevoTenant('factura-fresca');
    await withTenant(admin, id, (c) => ensureSubscription(c, id));
    await admin.query(
      `INSERT INTO invoices (tenant_id, period_start, period_end, lines, total_clp, due_at, status)
       VALUES ($1, now()::date, now()::date, '[]'::jsonb, 1000, now() + interval '20 days', 'issued')`,
      [id],
    );
    expect(await conTrabajo()).toContain(id);
  });

  it('en solo lectura SÍ entra: el paso cuenta los días para suspender', async () => {
    const id = await nuevoTenant('en-solo-lectura');
    await admin.query("UPDATE tenants SET state = 'read_only' WHERE id = $1", [id]);
    expect(await conTrabajo()).toContain(id);
  });

  it('una prueba vencida SÍ entra', async () => {
    const id = await nuevoTenant('prueba-vencida');
    await admin.query(
      "UPDATE tenants SET state = 'trial', trial_ends_at = now() - interval '1 day' WHERE id = $1",
      [id],
    );
    expect(await conTrabajo()).toContain(id);
  });

  it('una prueba que sigue viva NO entra', async () => {
    const id = await nuevoTenant('prueba-viva');
    await admin.query(
      "UPDATE tenants SET state = 'trial', trial_ends_at = now() + interval '5 days' WHERE id = $1",
      [id],
    );
    expect(await conTrabajo()).not.toContain(id);
  });

  it('una cancelación con fecha cumplida SÍ entra', async () => {
    const id = await nuevoTenant('cancelada');
    await withTenant(admin, id, (c) => ensureSubscription(c, id));
    await admin.query(
      `UPDATE subscriptions SET status = 'cancelled', cancel_at = (now() - interval '1 day')::date,
              next_charge_at = (now() + interval '20 days')::date
        WHERE tenant_id = $1`,
      [id],
    );
    expect(await conTrabajo()).toContain(id);
  });

  it('un tenant borrado NO entra, pase lo que pase con sus facturas', async () => {
    const id = await nuevoTenant('borrado');
    await withTenant(admin, id, (c) => ensureSubscription(c, id));
    await admin.query(
      "UPDATE subscriptions SET next_charge_at = (now() - interval '1 day')::date WHERE tenant_id = $1",
      [id],
    );
    await admin.query("UPDATE tenants SET state = 'deleted' WHERE id = $1", [id]);
    expect(await conTrabajo()).not.toContain(id);
  });

  it('la función devuelve SOLO ids: no filtra ningún otro dato', async () => {
    // Es la mitad de por qué el agujero es aceptable (ADR-0026). `tenants` no
    // tiene RLS, así que esos ids ya son visibles para el rol de la aplicación:
    // lo único que agrega la función es cuáles tienen trabajo.
    const r = await admin.query('SELECT * FROM tenants_con_trabajo_de_facturacion() LIMIT 1');
    expect(r.fields.map((f) => f.name)).toEqual(['tenant_id']);
  });

  it('el barrido sigue haciendo el trabajo que hay que hacer', async () => {
    // Lo que importa: visitar menos no puede significar hacer menos. Éste es el
    // tenant del ciclo vencido de arriba, y el barrido tiene que emitirle.
    const antes = await conTrabajo();
    expect(antes.length).toBeGreaterThan(0);
    const res = await sweepBilling(admin);
    expect(res.issued).toBeGreaterThan(0);
  }, 30_000);
});
