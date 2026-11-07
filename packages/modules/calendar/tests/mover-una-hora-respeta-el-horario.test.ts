import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { agendar, definirDisponibilidad, huecosDelDia, reagendarCita } from '../contract';

/**
 * Mover una hora respeta el horario publicado tanto como tomarla (#1251).
 *
 * El ADR-0029 abrió `calendar.book` al agente con UNA garantía: el inicio se
 * valida contra la disponibilidad real dentro del cerrojo. `reagendarCita`
 * toma el mismo cerrojo y comprueba que no choque con otra cita, pero NO que
 * el horario nuevo exista en la disponibilidad. Así que la garantía del ADR se
 * esquiva moviendo: se toma un hueco legítimo y después se mueve a las tres de
 * la mañana de un domingo.
 *
 * Y hay un detalle que solo aparece al mover: la cita que se está moviendo
 * ocupa su propio hueco. Validar contra `huecosDelDia` sin excluirla rechaza
 * movimientos legítimos —dejarla a la misma hora cambiándole la duración, o
 * correrla al bloque de al lado cuando hay respiro—, que es la clase de
 * arreglo que es peor que el defecto.
 */
let pool: Pool;
let tenant: string;
let contacto: string;
const duena = randomUUID();
// Agenda aparte: la prueba de la duración necesita la mañana entera libre.
const duenaSola = randomUUID();

/** Un martes lejano: una prueba no mide el calendario real. */
const MARTES = '2030-06-11';
const H = (hhmm: string) => new Date(`${MARTES}T${hhmm}:00-04:00`);

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (
    await pool.query("INSERT INTO tenants(name) VALUES('Barbería que mueve horas') RETURNING id")
  ).rows[0].id;
  contacto = (
    await pool.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1,'Cliente',$2,'whatsapp') RETURNING id`,
      [tenant, `+569${String(Date.now()).slice(-8)}`],
    )
  ).rows[0].id;
  // Martes de 09:00 a 12:00, bloques de 30 minutos, sin respiro.
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
  await withTenant(pool, tenant, (c) =>
    definirDisponibilidad(c, {
      tenantId: tenant,
      ownerId: duenaSola,
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

async function tomar(inicio: Date, fin: Date, dueno = duena) {
  return withTenant(pool, tenant, (c) =>
    agendar(c, {
      tenantId: tenant,
      contactId: contacto,
      ownerId: dueno,
      inicio,
      fin,
      confirmada: true,
      exigirHuecoDisponible: true,
      actor: duena,
      actorKind: 'agent',
    }),
  );
}

async function mover(id: string, inicio: Date, fin: Date) {
  return withTenant(pool, tenant, (c) =>
    reagendarCita(c, {
      tenantId: tenant,
      appointmentId: id,
      inicio,
      fin,
      exigirHuecoDisponible: true,
      actor: duena,
      actorKind: 'agent',
    }),
  );
}

describe('el agente no se salta el horario moviendo la hora (#1251)', () => {
  it('no mueve una hora fuera de la disponibilidad', async () => {
    const cita = await tomar(H('09:00'), H('09:30'));
    await expect(mover(cita.id, H('03:00'), H('03:30'))).rejects.toThrow(/no está disponible/i);
  });

  it('no mueve una hora al día siguiente, que no tiene disponibilidad', async () => {
    const cita = await tomar(H('09:30'), H('10:00'));
    const miercoles = new Date('2030-06-12T10:00:00-04:00');
    await expect(
      mover(cita.id, miercoles, new Date(miercoles.getTime() + 30 * 60_000)),
    ).rejects.toThrow(/no está disponible/i);
  });

  it('mueve a un hueco legítimo', async () => {
    const cita = await tomar(H('10:00'), H('10:30'));
    const movida = await mover(cita.id, H('11:00'), H('11:30'));
    expect(new Date(movida.startsAt).toISOString()).toBe(H('11:00').toISOString());
  });

  it('la cita que se mueve no se bloquea a sí misma', async () => {
    // Dejarla donde está: el hueco está ocupado por ella y por nadie más.
    const cita = await tomar(H('11:30'), H('12:00'));
    const quieta = await mover(cita.id, H('11:30'), H('12:00'));
    expect(new Date(quieta.startsAt).toISOString()).toBe(H('11:30').toISOString());
  });

  it('y el hueco de la cita que se mueve no se le ofrece a otro mientras tanto', async () => {
    // Lo que NO debe pasar por excluirla: que su propio hueco se vea libre
    // para una cita distinta.
    const libres = await withTenant(pool, tenant, (c) =>
      huecosDelDia(c, { tenantId: tenant, ownerId: duena, dia: MARTES, ahora: H('08:00') }),
    );
    expect(libres.map((h) => h.hora)).not.toContain('11:30');
  });

  it('una cita que dura más que el bloque ofrecido no se agenda', async () => {
    // El inicio es un hueco real y el fin no lo mira nadie: el agente podía
    // tomar tres horas desde un bloque de treinta minutos y dejar la mañana
    // entera bloqueada sin chocar con nada.
    await expect(tomar(H('09:00'), H('12:00'), duenaSola)).rejects.toThrow(/dura 30 minutos, no 180/);
  });
});
