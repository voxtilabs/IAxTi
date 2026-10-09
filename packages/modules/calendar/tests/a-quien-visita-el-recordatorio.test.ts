import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import { barrerRecordatorios } from '../application/recordatorios';

/**
 * A quién visita el barrido de recordatorios (#733, ADR-0026).
 *
 * Recorría TODOS los tenants vivos y, por cada uno, corría una consulta por
 * cada aviso de `AVISOS` para descubrir que no tiene citas. Medido el 09/10 con
 * 1.283 tenants: 4,5 ms cada uno, ~5,8 s el barrido entero — y éste corre cada
 * pocos minutos, no una vez al día.
 *
 * Lo que estas pruebas cuidan es la propiedad que hace seguro el filtro: **que
 * no se pierda un recordatorio**. Un barrido que visita menos y deja a un
 * cliente sin su aviso es peor que uno lento.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
const tenants: string[] = [];
const AHORA = new Date('2027-06-07T12:00:00Z');

async function tenantConCita(horasDesdeAhora: number | null): Promise<string> {
  const id = (
    await admin.query("INSERT INTO tenants (name) VALUES ('recordatorios-filtro') RETURNING id")
  ).rows[0].id;
  tenants.push(id);
  if (horasDesdeAhora === null) return id;
  const contacto = (
    await admin.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin)
       VALUES ($1, 'Rocío', $2, 'whatsapp') RETURNING id`,
      [id, `+5699${Math.floor(Math.random() * 10_000_000)}`],
    )
  ).rows[0].id;
  const inicio = new Date(AHORA.getTime() + horasDesdeAhora * 3_600_000);
  await admin.query(
    `INSERT INTO appointments (tenant_id, contact_id, owner_id, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5, 'confirmed')`,
    [id, contacto, randomUUID(), inicio, new Date(inicio.getTime() + 30 * 60_000)],
  );
  return id;
}

const visitados = async (): Promise<string[]> =>
  (
    await admin.query('SELECT tenant_id FROM tenants_con_citas_por_recordar($1::timestamptz)', [
      AHORA,
    ])
  ).rows.map((f) => f.tenant_id as string);

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
});

afterAll(async () => {
  for (const t of tenants) {
    for (const tabla of ['appointments', 'contacts', 'outbox']) {
      await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [t]);
    }
  }
  await admin.end();
});

describe('el filtro mira el MISMO reloj que el barrido (#733)', () => {
  it('con una cita dentro de la ventana, el tenant entra', async () => {
    const id = await tenantConCita(2);
    expect(await visitados()).toContain(id);
  });

  it('con una cita a 24 h justas, también: es el aviso más lejano', async () => {
    const id = await tenantConCita(24);
    expect(await visitados()).toContain(id);
  });

  it('con una cita MUY lejana, no: no hay nada que recordar todavía', async () => {
    const id = await tenantConCita(72);
    expect(await visitados()).not.toContain(id);
  });

  it('sin ninguna cita, tampoco. Es el 99 % y es el que costaba 4,5 ms', async () => {
    const id = await tenantConCita(null);
    expect(await visitados()).not.toContain(id);
  });

  it('una cita que ya pasó hace rato queda fuera', async () => {
    // Un «te recuerdo tu hora» que llega después de la hora es peor que ninguno.
    const id = await tenantConCita(-5);
    expect(await visitados()).not.toContain(id);
  });

  it('una que pasó hace menos de una hora SÍ entra: es la holgura del barrido', async () => {
    // «Si el barrido se cae y se levanta cuarenta minutos después, el
    // recordatorio igual sale». La ventana del filtro tiene que cubrir esa
    // holgura, o el filtro le quitaría al barrido justo lo que ese margen
    // rescata.
    const id = await tenantConCita(-0.5);
    expect(await visitados()).toContain(id);
  });

  it('el filtro usa el reloj que se le pasa, no el de la máquina', async () => {
    // Ésta es la que importa y la que cazó el defecto: con `now()` en el SQL y
    // un reloj inyectado en el barrido, el filtro no veía al tenant que sí
    // tenía cita para ese reloj. Un filtro que solo acierta en producción es la
    // clase de cosa que después nadie entiende.
    const id = await tenantConCita(2);
    const conOtroReloj = (
      await admin.query('SELECT tenant_id FROM tenants_con_citas_por_recordar($1::timestamptz)', [
        new Date(AHORA.getTime() + 30 * 24 * 3_600_000),
      ])
    ).rows.map((f) => f.tenant_id as string);
    expect(await visitados()).toContain(id);
    expect(conOtroReloj, 'con otro instante, otra respuesta').not.toContain(id);
  });

  it('la función devuelve SOLO ids', async () => {
    const r = await admin.query(
      'SELECT * FROM tenants_con_citas_por_recordar($1::timestamptz) LIMIT 1',
      [AHORA],
    );
    expect(r.fields.map((f) => f.name)).toEqual(['tenant_id']);
  });

  it('y el barrido sigue mandando lo que hay que mandar', async () => {
    // Visitar menos no puede significar hacer menos.
    const id = await tenantConCita(2);
    const enviar = vi.fn(async () => ({ enviado: true }));
    const res = await barrerRecordatorios(admin, { enviar, ahora: AHORA });
    expect(res.enviados).toBeGreaterThan(0);
    expect(enviar).toHaveBeenCalled();
    void id;
  }, 30_000);
});
