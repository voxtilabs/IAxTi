import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  abrirDias,
  agendar,
  cerrarDias,
  citasDentroDelCierre,
  definirDisponibilidad,
  huecosDelDia,
  listarCierres,
} from '../contract';

/**
 * Los días que el negocio no abre (#1281).
 *
 * `availability` guarda el horario por día de la semana, así que un feriado no
 * tenía dónde ir: el 18 de septiembre de 2026 cae viernes y una barbería que
 * atiende los viernes confirmaba horas para ese día. Con el agente tomando
 * horas solo (ADR-0029), el cliente llegaba a la puerta cerrada con una
 * confirmación de WhatsApp en la mano.
 */
let pool: Pool;
let tenant: string;
let contacto: string;
const ana = randomUUID();
const beto = randomUUID();

/** Martes y miércoles de una semana lejana: una prueba no mide el calendario real. */
const MARTES = '2030-06-11';
const MIERCOLES = '2030-06-12';
const JUEVES = '2030-06-13';
const H = (dia: string, hhmm: string) => new Date(`${dia}T${hhmm}:00-04:00`);

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (
    await pool.query("INSERT INTO tenants(name) VALUES('Barbería que cierra') RETURNING id")
  ).rows[0].id;
  contacto = (
    await pool.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1,'Cliente',$2,'whatsapp') RETURNING id`,
      [tenant, `+569${String(Date.now()).slice(-8)}`],
    )
  ).rows[0].id;
  for (const duena of [ana, beto]) {
    for (const weekday of [2, 3, 4]) {
      await withTenant(pool, tenant, (c) =>
        definirDisponibilidad(c, {
          tenantId: tenant,
          ownerId: duena,
          weekday,
          inicioMin: 9 * 60,
          finMin: 12 * 60,
          duracion: 30,
          respiro: 0,
        }),
      );
    }
  }
});

afterAll(async () => {
  await pool?.end();
});

const huecos = (dia: string, duena: string) =>
  withTenant(pool, tenant, (c) =>
    huecosDelDia(c, { tenantId: tenant, ownerId: duena, dia, ahora: H(MARTES, '07:00') }),
  );

const cerrar = (input: Parameters<typeof cerrarDias>[1]) =>
  withTenant(pool, tenant, (c) => cerrarDias(c, input));

describe('cerrar un día (#1281)', () => {
  it('un día cerrado no ofrece ningún horario', async () => {
    expect((await huecos(MARTES, ana)).length).toBeGreaterThan(0);
    const cierre = await cerrar({
      tenantId: tenant,
      ownerId: ana,
      desde: MARTES,
      motivo: 'al dentista',
      actor: ana,
    });
    expect(await huecos(MARTES, ana)).toEqual([]);
    // Y se reabre.
    const borrado = await withTenant(pool, tenant, (c) =>
      abrirDias(c, { tenantId: tenant, cierreId: cierre.id, actor: ana }),
    );
    expect(borrado).toBe(true);
    expect((await huecos(MARTES, ana)).length).toBeGreaterThan(0);
  });

  it('el agente no puede tomar una hora en un día cerrado', async () => {
    const cierre = await cerrar({ tenantId: tenant, ownerId: ana, desde: MIERCOLES, actor: ana });
    await expect(
      withTenant(pool, tenant, (c) =>
        agendar(c, {
          tenantId: tenant,
          contactId: contacto,
          ownerId: ana,
          inicio: H(MIERCOLES, '10:00'),
          fin: H(MIERCOLES, '10:30'),
          exigirHuecoDisponible: true,
          actor: ana,
          actorKind: 'agent',
        }),
      ),
    ).rejects.toThrow(/no está disponible/i);
    await withTenant(pool, tenant, (c) =>
      abrirDias(c, { tenantId: tenant, cierreId: cierre.id }),
    );
  });

  it('las vacaciones de una persona no cierran la agenda del resto', async () => {
    const cierre = await cerrar({
      tenantId: tenant,
      ownerId: ana,
      desde: MARTES,
      hasta: JUEVES,
      motivo: 'vacaciones',
      actor: ana,
    });
    expect(await huecos(MARTES, ana)).toEqual([]);
    expect(await huecos(JUEVES, ana)).toEqual([]);
    expect((await huecos(MARTES, beto)).length).toBeGreaterThan(0);
    await withTenant(pool, tenant, (c) => abrirDias(c, { tenantId: tenant, cierreId: cierre.id }));
  });

  it('un feriado cierra para todo el equipo', async () => {
    // Sin ownerId: es del negocio, no de una persona.
    const cierre = await cerrar({
      tenantId: tenant,
      desde: MIERCOLES,
      motivo: 'feriado',
      actor: ana,
    });
    expect(await huecos(MIERCOLES, ana)).toEqual([]);
    expect(await huecos(MIERCOLES, beto)).toEqual([]);
    // Y el día de al lado sigue abierto para los dos: cerrar un día cierra UN día.
    expect((await huecos(JUEVES, ana)).length).toBeGreaterThan(0);
    await withTenant(pool, tenant, (c) => abrirDias(c, { tenantId: tenant, cierreId: cierre.id }));
  });

  it('el rango incluye los dos extremos', async () => {
    const cierre = await cerrar({ tenantId: tenant, desde: MARTES, hasta: MIERCOLES, actor: ana });
    expect(await huecos(MARTES, ana)).toEqual([]);
    expect(await huecos(MIERCOLES, ana)).toEqual([]);
    expect((await huecos(JUEVES, ana)).length).toBeGreaterThan(0);
    await withTenant(pool, tenant, (c) => abrirDias(c, { tenantId: tenant, cierreId: cierre.id }));
  });

  it('cerrar NO cancela las citas que ya estaban: las deja para que una persona resuelva', async () => {
    const cita = await withTenant(pool, tenant, (c) =>
      agendar(c, {
        tenantId: tenant,
        contactId: contacto,
        ownerId: beto,
        inicio: H(JUEVES, '10:00'),
        fin: H(JUEVES, '10:30'),
        confirmada: true,
        exigirHuecoDisponible: true,
        actor: beto,
      }),
    );
    const cierre = await cerrar({ tenantId: tenant, ownerId: beto, desde: JUEVES, actor: beto });
    const dentro = await withTenant(pool, tenant, (c) =>
      citasDentroDelCierre(c, {
        tenantId: tenant,
        ownerId: beto,
        desde: JUEVES,
        hasta: JUEVES,
        zona: 'America/Santiago',
      }),
    );
    expect(dentro.map((c) => c.id)).toContain(cita.id);
    // Sigue confirmada: nadie le avisó nada al cliente todavía, y eso es lo correcto.
    const estado = await withTenant(pool, tenant, (c) =>
      c.query('SELECT status FROM appointments WHERE id = $1', [cita.id]),
    );
    expect(estado.rows[0].status).toBe('confirmed');
    await withTenant(pool, tenant, (c) => abrirDias(c, { tenantId: tenant, cierreId: cierre.id }));
  });

  it('el día de corte sale de la zona del negocio, no de UTC', async () => {
    // El defecto que esto fija: con el corte calculado en UTC, a las 21:00 en
    // Chile ya es mañana, y el cierre de HOY desaparecía de la lista justo la
    // noche anterior al día que cierra. Hacen falta dos instantes del mismo
    // día local para verlo: uno de mañana y uno de noche.
    const cierre = await cerrar({ tenantId: tenant, desde: MARTES, actor: ana });
    const deDia = new Date(`${MARTES}T10:00:00-04:00`);
    const deNoche = new Date(`${MARTES}T22:00:00-04:00`);
    for (const ahora of [deDia, deNoche]) {
      const vigentes = await withTenant(pool, tenant, (c) =>
        listarCierres(c, { tenantId: tenant, ahora }),
      );
      expect(vigentes.map((c) => c.id), `a las ${ahora.toISOString()}`).toContain(cierre.id);
    }
    await withTenant(pool, tenant, (c) => abrirDias(c, { tenantId: tenant, cierreId: cierre.id }));
  });

  it('un cierre al revés se rechaza, y reabrir algo que no existe dice que no existe', async () => {
    await expect(
      cerrar({ tenantId: tenant, desde: JUEVES, hasta: MARTES, actor: ana }),
    ).rejects.toThrow(/termina antes de empezar/i);
    const borrado = await withTenant(pool, tenant, (c) =>
      abrirDias(c, { tenantId: tenant, cierreId: randomUUID() }),
    );
    expect(borrado).toBe(false);
  });

  it('la lista muestra lo que viene y no el historial', async () => {
    const viejo = await cerrar({ tenantId: tenant, desde: '2020-01-01', actor: ana });
    const nuevo = await cerrar({ tenantId: tenant, desde: MARTES, actor: ana });
    const vigentes = await withTenant(pool, tenant, (c) =>
      listarCierres(c, { tenantId: tenant, desdeElDia: '2029-01-01' }),
    );
    const ids = vigentes.map((c) => c.id);
    expect(ids).toContain(nuevo.id);
    expect(ids).not.toContain(viejo.id);
    // Y la fecha vuelve como el día que se guardó, sin corrimiento de zona.
    expect(vigentes.find((c) => c.id === nuevo.id)?.desde).toBe(MARTES);
    for (const c of [viejo, nuevo]) {
      await withTenant(pool, tenant, (cl) => abrirDias(cl, { tenantId: tenant, cierreId: c.id }));
    }
  });
});
