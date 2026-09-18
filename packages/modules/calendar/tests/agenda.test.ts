import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  agendar,
  cambiarEstadoCita,
  definirDisponibilidad,
  huecosDelDia,
  listarCitas,
} from '../application/agenda';

/**
 * La agenda contra la base (SPEC §16). Lo que se prueba acá es lo que pasa
 * en la zona del NEGOCIO y en los bordes: la hora que se acaba de tomar, la
 * anticipación mínima, y que una cita a la que nadie llegó no se "arregle"
 * después.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let contacto: string;
const duena = randomUUID();

const en = <T>(fn: (c: never) => Promise<T>) => withTenant(admin, tenant, fn as never);

/** Un lunes lejano, para que la anticipación mínima nunca lo descarte. */
const LUNES = '2027-03-01';
const ANTES = new Date('2027-02-25T12:00:00Z');

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, timezone) VALUES ('agenda-test', 'America/Santiago') RETURNING id",
  );
  tenant = t.rows[0].id;
  const c = await admin.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1, 'Rocío', '+56988880001', 'whatsapp') RETURNING id`,
    [tenant],
  );
  contacto = c.rows[0].id;
  // Lunes de 09:00 a 12:00, citas de 30 con 15 de respiro.
  await en((cl) =>
    definirDisponibilidad(cl, {
      tenantId: tenant,
      ownerId: duena,
      weekday: 1,
      inicioMin: 540,
      finMin: 720,
      duracion: 30,
      respiro: 15,
      anticipacionMin: 60,
    }),
  );
});

afterAll(async () => {
  await admin.end();
});

describe('los huecos que se pueden ofrecer', () => {
  it('salen de la disponibilidad del día, en la hora del negocio', async () => {
    const huecos = await en((c) => huecosDelDia(c, { tenantId: tenant, ownerId: duena, dia: LUNES, ahora: ANTES }));
    expect(huecos.length).toBeGreaterThan(0);
    expect(huecos[0].hora).toBe('09:00');
    // 30 de cita + 15 de respiro: el siguiente es a las 09:45.
    expect(huecos[1].hora).toBe('09:45');
  });

  it('un día sin disponibilidad no ofrece nada', async () => {
    const domingo = '2027-02-28';
    expect(await en((c) => huecosDelDia(c, { tenantId: tenant, ownerId: duena, dia: domingo, ahora: ANTES }))).toEqual([]);
  });

  it('la anticipación mínima descarta lo que es para dentro de un rato', async () => {
    // "Ahora" es el mismo lunes a las 08:30 hora de Chile: las 09:00 quedan
    // a media hora y la anticipación pide una.
    const casiLaHora = new Date('2027-03-01T11:30:00Z'); // 08:30 en Santiago
    const huecos = await en((c) =>
      huecosDelDia(c, { tenantId: tenant, ownerId: duena, dia: LUNES, ahora: casiLaHora }),
    );
    expect(huecos.map((h) => h.hora)).not.toContain('09:00');
    expect(huecos.map((h) => h.hora)).toContain('09:45');
  });
});

describe('agendar', () => {
  let cita: string;

  it('toma la hora y el hueco desaparece de la oferta', async () => {
    const huecos = await en((c) => huecosDelDia(c, { tenantId: tenant, ownerId: duena, dia: LUNES, ahora: ANTES }));
    const primero = huecos[0];
    const c = await en((cl) =>
      agendar(cl, {
        tenantId: tenant,
        contactId: contacto,
        ownerId: duena,
        inicio: primero.inicio,
        fin: primero.fin,
        title: 'Corte y color',
        confirmada: true,
      }),
    );
    cita = c.id;
    expect(c.status).toBe('confirmed');

    const despues = await en((cl) => huecosDelDia(cl, { tenantId: tenant, ownerId: duena, dia: LUNES, ahora: ANTES }));
    expect(despues.map((h) => h.hora)).not.toContain('09:00');
  });

  it('dos citas no ocupan el mismo lugar, aunque se pidan a la vez', async () => {
    const huecos = await en((c) => huecosDelDia(c, { tenantId: tenant, ownerId: duena, dia: LUNES, ahora: ANTES }));
    const libre = huecos[0];
    await en((cl) =>
      agendar(cl, { tenantId: tenant, contactId: contacto, ownerId: duena, inicio: libre.inicio, fin: libre.fin }),
    );
    // La misma hora otra vez: entre que la IA ofreció y la persona eligió,
    // alguien más la tomó.
    await expect(
      en((cl) =>
        agendar(cl, { tenantId: tenant, contactId: contacto, ownerId: duena, inicio: libre.inicio, fin: libre.fin }),
      ),
    ).rejects.toThrow(/se acaba de tomar/);
  });

  it('la agenda del día muestra lo tomado', async () => {
    const lista = await en((c) =>
      listarCitas(c, {
        tenantId: tenant,
        ownerId: duena,
        desde: new Date('2027-03-01T00:00:00Z'),
        hasta: new Date('2027-03-02T23:59:00Z'),
      }),
    );
    expect(lista.length).toBeGreaterThanOrEqual(2);
  });

  it('el no-show avisa, y no se puede deshacer cambiándole el estado', async () => {
    await en((c) => cambiarEstadoCita(c, { tenantId: tenant, appointmentId: cita, to: 'no_show' }));
    const evento = await admin.query(
      `SELECT payload FROM outbox WHERE tenant_id = $1 AND name = 'appointment.no_show' ORDER BY id DESC LIMIT 1`,
      [tenant],
    );
    expect(evento.rows[0].payload.appointmentId).toBe(cita);

    // Una cita a la que alguien no llegó no se arregla después: se agenda otra.
    await expect(
      en((c) => cambiarEstadoCita(c, { tenantId: tenant, appointmentId: cita, to: 'attended' })),
    ).rejects.toThrow(/Transición de cita inválida/);
  });
});

describe('lo que la persona tiene ocupado FUERA de IAxTi (#57)', () => {
  it('una reunión del calendario personal tapa el hueco', async () => {
    const sinNada = await en((c) =>
      huecosDelDia(c, { tenantId: tenant, ownerId: duena, dia: LUNES, ahora: ANTES }),
    );
    expect(sinNada[0].hora).toBe('09:00');

    // 09:00 a 09:30 en minutos locales: lo que devolvería el free/busy de
    // Google para una reunión que no creamos nosotros.
    const conReunion = await en((c) =>
      huecosDelDia(c, {
        tenantId: tenant,
        ownerId: duena,
        dia: LUNES,
        ahora: ANTES,
        ocupadoExterno: [{ inicio: 540, fin: 570 }],
      }),
    );
    // Ofrecer una hora que la persona ya tiene tomada es peor que no
    // ofrecer nada: el cliente ya reservó y alguien queda mal.
    expect(conReunion.map((h) => h.hora)).not.toContain('09:00');
    expect(conReunion.length).toBe(sinNada.length - 1);
  });

  it('el respiro se cuenta también alrededor de lo de afuera', async () => {
    // Una reunión que termina 09:35 deja el hueco de 09:45 pegado: con 15
    // minutos de respiro, tampoco sirve.
    const huecos = await en((c) =>
      huecosDelDia(c, {
        tenantId: tenant,
        ownerId: duena,
        dia: LUNES,
        ahora: ANTES,
        ocupadoExterno: [{ inicio: 540, fin: 575 }],
      }),
    );
    expect(huecos.map((h) => h.hora)).not.toContain('09:00');
    expect(huecos.map((h) => h.hora)).not.toContain('09:45');
  });

  it('sin ocupado externo se comporta igual que antes', async () => {
    const a = await en((c) => huecosDelDia(c, { tenantId: tenant, ownerId: duena, dia: LUNES, ahora: ANTES }));
    const b = await en((c) =>
      huecosDelDia(c, { tenantId: tenant, ownerId: duena, dia: LUNES, ahora: ANTES, ocupadoExterno: [] }),
    );
    expect(b.map((h) => h.hora)).toEqual(a.map((h) => h.hora));
  });
});
