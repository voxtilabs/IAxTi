import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { agendar } from '../application/agenda';
import {
  barrerRecordatorios,
  citasPorRecordar,
  marcarAvisoEnviado,
  type CitaPorRecordar,
} from '../application/recordatorios';

/**
 * Recordatorios (#59). "La cita que no se recuerda no se asiste", y un
 * no-show es una hora que la pyme no cobra y no recupera.
 *
 * Lo que se prueba acá es sobre todo que NO salga dos veces: un recordatorio
 * repetido es de las cosas que hacen que alguien bloquee un número.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let contacto: string;
const duena = randomUUID();
const AHORA = new Date('2027-03-01T12:00:00Z');

const en = <T>(fn: (c: never) => Promise<T>) => withTenant(admin, tenant, fn as never);

async function citaEn(horasDesdeAhora: number) {
  const inicio = new Date(AHORA.getTime() + horasDesdeAhora * 3600_000);
  const fin = new Date(inicio.getTime() + 30 * 60_000);
  return en((c) =>
    agendar(c, {
      tenantId: tenant,
      contactId: contacto,
      ownerId: duena,
      inicio,
      fin,
      confirmada: true,
    }),
  );
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('recordatorios-test') RETURNING id");
  tenant = t.rows[0].id;
  const c = await admin.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1, 'Javiera', '+56977770909', 'whatsapp') RETURNING id`,
    [tenant],
  );
  contacto = c.rows[0].id;
});

afterAll(async () => {
  await admin.end();
});

describe('a quién le toca recordatorio', () => {
  it('a la de mañana le toca el de 24 h; a la de dentro de dos horas, el de 2 h', async () => {
    await citaEn(23.5); // entra en la ventana de 24 h
    await citaEn(1.8); // entra en la de 2 h
    await citaEn(72); // todavía no le toca nada

    const pendientes = await en((c) => citasPorRecordar(c, { tenantId: tenant, ahora: AHORA }));
    const avisos = pendientes.map((p) => p.aviso).sort();
    expect(avisos).toEqual(['24h', '2h'].sort());
  });

  it('una cancelada no recibe recordatorio', async () => {
    const cita = await citaEn(20);
    await admin.query("UPDATE appointments SET status = 'cancelled' WHERE id = $1", [cita.id]);
    const pendientes = await en((c) => citasPorRecordar(c, { tenantId: tenant, ahora: AHORA }));
    expect(pendientes.map((p) => p.appointmentId)).not.toContain(cita.id);
  });
});

describe('que no salga dos veces', () => {
  it('marcar el aviso es lo que decide, y solo funciona una vez', async () => {
    const cita = await citaEn(23);
    const primero = await en((c) =>
      marcarAvisoEnviado(c, { tenantId: tenant, appointmentId: cita.id, aviso: '24h' }),
    );
    const segundo = await en((c) =>
      marcarAvisoEnviado(c, { tenantId: tenant, appointmentId: cita.id, aviso: '24h' }),
    );
    expect(primero).toBe(true);
    expect(segundo).toBe(false);

    // Confirmada pasa a recordada, y queda el evento.
    const fila = await admin.query('SELECT status, reminders_sent FROM appointments WHERE id = $1', [cita.id]);
    expect(fila.rows[0].status).toBe('reminded');
    expect(fila.rows[0].reminders_sent).toEqual(['24h']);

    const evento = await admin.query(
      `SELECT count(*)::int n FROM outbox WHERE tenant_id = $1 AND name = 'appointment.reminder_sent'`,
      [tenant],
    );
    expect(evento.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('el barrido manda cada aviso UNA vez, aunque se corra dos veces', async () => {
    const mandados: CitaPorRecordar[] = [];
    const enviar = async (cita: CitaPorRecordar) => {
      mandados.push(cita);
      return { enviado: true };
    };

    const primera = await barrerRecordatorios(admin, { enviar, ahora: AHORA });
    const cuantos = mandados.length;
    expect(primera.enviados).toBe(cuantos);
    expect(cuantos).toBeGreaterThan(0);

    const segunda = await barrerRecordatorios(admin, { enviar, ahora: AHORA });
    expect(segunda.enviados).toBe(0);
    expect(mandados.length).toBe(cuantos);
  });

  it('si el envío falla, el aviso NO se reintenta: mejor uno que falta que tres iguales', async () => {
    // 1,2 h: dentro de la ventana de 2 h y sin pisar la cita de 1,8 h.
    const cita = await citaEn(1.2);
    const res = await barrerRecordatorios(admin, {
      enviar: async () => ({ enviado: false, motivo: 'la plantilla no está aprobada' }),
      ahora: AHORA,
    });
    expect(res.saltados).toBeGreaterThanOrEqual(1);
    const fila = await admin.query('SELECT reminders_sent FROM appointments WHERE id = $1', [cita.id]);
    expect(fila.rows[0].reminders_sent).toContain('2h');
  });
});
