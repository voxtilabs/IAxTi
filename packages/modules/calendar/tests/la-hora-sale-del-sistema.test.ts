import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { agendar, definirDisponibilidad, huecosDelDia } from '../contract';

/**
 * La hora la elige el sistema, no el modelo (ADR-0029).
 *
 * `calendar.book` se abrió al agente autónomo con UNA garantía: el inicio que
 * mande se valida contra la disponibilidad real **dentro del cerrojo** que
 * `agendar` ya toma. Sin eso, lo peor que podría pasar es que el modelo
 * agende un domingo a las 3 de la mañana con total seguridad; con eso, lo
 * peor es que le agende a quien solo preguntaba — un error de criterio y no
 * uno de datos.
 *
 * Esto prueba la garantía, que es lo único que sostiene el ADR.
 */
let pool: Pool;
let tenant: string;
let contacto: string;
const duena = randomUUID();

/** Un martes cualquiera, lejos de hoy: una prueba no mide el calendario real. */
const MARTES = '2030-06-11';

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants(name) VALUES('Barbería del ADR') RETURNING id")).rows[0].id;
  contacto = (
    await pool.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1,'Cliente',$2,'whatsapp') RETURNING id`,
      [tenant, `+569${String(Date.now()).slice(-8)}`],
    )
  ).rows[0].id;
  // Martes de 09:00 a 12:00, bloques de 30 minutos.
  await withTenant(pool, tenant, (c) =>
    definirDisponibilidad(c, {
      tenantId: tenant,
      ownerId: duena,
      weekday: 2,
      // En minutos desde medianoche, que es como lo guarda la tabla.
      inicioMin: 9 * 60,
      finMin: 12 * 60,
      duracion: 30,
      respiro: 0,
    }),
  );
});

afterAll(async () => { await pool?.end(); });

async function huecos() {
  return withTenant(pool, tenant, (c) => huecosDelDia(c, { tenantId: tenant, ownerId: duena, dia: MARTES }));
}

async function tomar(inicio: Date, fin: Date, exigir: boolean) {
  return withTenant(pool, tenant, (c) =>
    agendar(c, {
      tenantId: tenant,
      contactId: contacto,
      ownerId: duena,
      inicio,
      fin,
      confirmada: true,
      exigirHuecoDisponible: exigir,
      actor: duena,
      actorKind: 'agent',
    }),
  );
}

describe('el agente solo puede tomar un hueco que el sistema ofrece (ADR-0029)', () => {
  it('un horario de la lista se toma', async () => {
    const libres = await huecos();
    expect(libres.length).toBeGreaterThan(0);
    const h = libres[0]!;
    const cita = await tomar(new Date(h.inicio), new Date(h.fin), true);
    expect(cita.status).toBe('confirmed');
  });

  /**
   * El caso que el ADR promete evitar. Un domingo a las 3 AM no choca con
   * ninguna cita, así que la comprobación de solape —la única que había— lo
   * dejaba pasar sin más.
   */
  it('un domingo a las 3 de la mañana NO, aunque no choque con nada', async () => {
    const domingo = new Date('2030-06-16T07:00:00.000Z');
    await expect(tomar(domingo, new Date('2030-06-16T07:30:00.000Z'), true)).rejects.toThrow(
      /ya no está disponible/,
    );
  });

  /**
   * A media hora de un bloque tampoco: los huecos empiezan en :00 y :30, y
   * una cita a las 09:15 parte en dos el resto del día.
   */
  it('a media hora de un bloque tampoco', async () => {
    const libres = await huecos();
    const h = libres.find((x) => new Date(x.inicio).getTime() > Date.now()) ?? libres[0]!;
    const corrido = new Date(new Date(h.inicio).getTime() + 15 * 60_000);
    await expect(
      tomar(corrido, new Date(corrido.getTime() + 30 * 60_000), true),
    ).rejects.toThrow(/ya no está disponible/);
  });

  /**
   * Y lo que NO se rompe: una persona del equipo sigue pudiendo dar una hora
   * fuera del horario publicado. Se quedó atendiendo, le hizo un favor a
   * alguien; eso es legítimo y el ADR no se lo quita. La diferencia es quién
   * agenda, y por eso la bandera existe en vez de ser el comportamiento.
   */
  it('una persona SÍ puede dar una hora fuera del horario publicado', async () => {
    const domingo = new Date('2030-06-16T07:00:00.000Z');
    const cita = await tomar(domingo, new Date('2030-06-16T07:30:00.000Z'), false);
    expect(cita.status).toBe('confirmed');
  });
});
