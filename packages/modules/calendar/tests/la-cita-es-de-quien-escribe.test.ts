import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { agendar, citasFuturasDelContacto, definirDisponibilidad } from '../contract';

/**
 * La cita que se mueve es la de quien escribe (#1283, ADR-0030).
 *
 * `calendar.reschedule` no recibe un id de cita, y esta consulta es la razón
 * de que pueda no recibirlo: la cita la elige el sistema a partir del contacto
 * de la conversación. Si el agente pudiera nombrar una cita, un UUID
 * alucinado movería la hora de otra persona —el riesgo exacto que la ADR-0017
 * nombró al cerrar esta herramienta—.
 *
 * Devuelve la LISTA y no la primera porque quien llama tiene que distinguir
 * tres casos: ninguna, una, y varias. El tercero no se adivina: escala.
 */
let pool: Pool;
let tenant: string;
let ana: string;
let beto: string;
const duena = randomUUID();

const MARTES = '2030-06-11';
const H = (hhmm: string) => new Date(`${MARTES}T${hhmm}:00-04:00`);
/** Lejos de cualquier cita: el «ahora» de las consultas, inyectado. */
const ANTES = new Date('2030-06-01T12:00:00Z');

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants(name) VALUES('Agenda de dos') RETURNING id"))
    .rows[0].id;
  const contacto = async (nombre: string) =>
    (
      await pool.query(
        `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1,$2,$3,'whatsapp') RETURNING id`,
        [tenant, nombre, `+569${String(Date.now() + Math.floor(Math.random() * 1e6)).slice(-8)}`],
      )
    ).rows[0].id;
  ana = await contacto('Ana');
  beto = await contacto('Beto');
  await withTenant(pool, tenant, (c) =>
    definirDisponibilidad(c, {
      tenantId: tenant,
      ownerId: duena,
      weekday: 2,
      inicioMin: 9 * 60,
      finMin: 12 * 60,
      duracion: 30,
      respiro: 0,
    }),
  );
});

afterAll(async () => {
  await pool?.end();
});

const tomar = (contactId: string, hhmm: string) =>
  withTenant(pool, tenant, (c) =>
    agendar(c, {
      tenantId: tenant,
      contactId,
      ownerId: duena,
      inicio: H(hhmm),
      fin: new Date(H(hhmm).getTime() + 30 * 60_000),
      confirmada: true,
      actor: duena,
    }),
  );

const suyas = (contactId: string, ahora = ANTES) =>
  withTenant(pool, tenant, (c) =>
    citasFuturasDelContacto(c, { tenantId: tenant, contactId, ahora }),
  );

describe('las citas futuras de quien escribe (#1283)', () => {
  it('devuelve las de ese contacto y NINGUNA de otro', async () => {
    const deAna = await tomar(ana, '09:00');
    const deBeto = await tomar(beto, '09:30');
    expect((await suyas(ana)).map((c) => c.id)).toEqual([deAna.id]);
    expect((await suyas(beto)).map((c) => c.id)).toEqual([deBeto.id]);
  });

  it('un contacto sin citas devuelve la lista vacía, no la de al lado', async () => {
    const nadie = (
      await pool.query(
        `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1,'Sin hora',$2,'whatsapp') RETURNING id`,
        [tenant, `+5699${String(Date.now()).slice(-7)}`],
      )
    ).rows[0].id;
    expect(await suyas(nadie)).toEqual([]);
  });

  it('no cuenta lo que ya pasó: una hora de ayer no se mueve, se toma otra', async () => {
    // El mismo martes, preguntado DESPUÉS de que terminó.
    const despues = new Date(`${MARTES}T23:00:00-04:00`);
    expect(await suyas(ana, despues)).toEqual([]);
  });

  it('no cuenta una cancelada: libera el hueco y deja de ser suya', async () => {
    const cita = await tomar(ana, '10:00');
    await withTenant(pool, tenant, (c) =>
      c.query(`UPDATE appointments SET status='cancelled' WHERE id = $1`, [cita.id]),
    );
    expect((await suyas(ana)).map((c) => c.id)).not.toContain(cita.id);
  });

  it('con varias, salen EN ORDEN: quien llama tiene que poder ver que son varias', async () => {
    await tomar(ana, '10:30');
    await tomar(ana, '11:00');
    const lista = await suyas(ana);
    expect(lista.length).toBeGreaterThan(1);
    const horas = lista.map((c) => new Date(c.startsAt).getTime());
    expect([...horas].sort((a, b) => a - b)).toEqual(horas);
  });
});
