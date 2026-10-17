import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { agendar, cambiarEstadoCita, reagendarCita } from '../application/agenda';
import { citasPorRecordar, marcarAvisoEnviado } from '../application/recordatorios';

/**
 * Mover una cita de hora (#836).
 *
 * SPEC §16 vendía «reagendar desde el chat» como regla y el manifiesto
 * declaraba la tool, y no existía función que moviera nada. El único camino
 * hasta `rescheduled` era forzar el estado, y llegar ahí dejaba las cosas
 * PEOR que no hacer nada: la cita congelada para siempre, la hora liberada
 * acá y todavía tomada en Google. #837 cerró esa puerta; esto es la función.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let contacto: string;
const duena = randomUUID();
const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);

/** Lejos, para que la anticipación mínima nunca entre en juego. */
const H = (iso: string) => new Date(`2027-05-10T${iso}:00Z`);

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (
    await admin.query(
      "INSERT INTO tenants (name, timezone) VALUES ('reagendar-test', 'America/Santiago') RETURNING id",
    )
  ).rows[0].id;
  contacto = (
    await admin.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin)
       VALUES ($1, 'Rocío', '+56988881234', 'whatsapp') RETURNING id`,
      [tenant],
    )
  ).rows[0].id;
});

afterAll(async () => {
  for (const t of ['appointments', 'outbox', 'audit_log', 'contacts']) {
    if (t === 'audit_log') {
      const { sinTriggers } = await import('@iaxti/db');
      await sinTriggers(admin, (c) => c.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]));
      continue;
    }
    await admin.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

beforeEach(async () => {
  await admin.query('DELETE FROM appointments WHERE tenant_id = $1', [tenant]);
  await admin.query("DELETE FROM outbox WHERE tenant_id = $1", [tenant]);
});

const nueva = (inicio: string, fin: string, confirmada = true) =>
  en((c) =>
    agendar(c, {
      tenantId: tenant,
      contactId: contacto,
      ownerId: duena,
      inicio: H(inicio),
      fin: H(fin),
      confirmada,
    }),
  );

describe('mover una cita de hora (#836)', () => {
  it('mueve la MISMA fila: no deja dos citas por un cambio de hora', async () => {
    const cita = await nueva('14:00', '14:30');
    const movida = await en((c) =>
      reagendarCita(c, { tenantId: tenant, appointmentId: cita.id, inicio: H('16:00'), fin: H('16:30') }),
    );

    expect(movida.id).toBe(cita.id);
    expect(new Date(movida.startsAt).toISOString()).toBe(H('16:00').toISOString());
    // Una sola fila: dos duplicarían el historial del contacto y obligarían a
    // explicar en la pantalla por qué hay dos citas para lo mismo.
    const cuantas = await admin.query('SELECT count(*)::int AS n FROM appointments WHERE tenant_id = $1', [tenant]);
    expect(cuantas.rows[0].n).toBe(1);
    // Y sigue confirmada: moverla de acuerdo con el cliente no la vuelve a
    // proponer.
    expect(movida.status).toBe('confirmed');
  });

  it('los recordatorios vuelven a cero, o el cliente nunca sabe de la hora nueva', async () => {
    /**
     * Esto es lo que de verdad importa de este cambio.
     *
     * El job salta la cita cuyo aviso ya figura en `reminders_sent`. Mover la
     * hora sin limpiarla deja al cliente SIN recordatorio de la hora nueva:
     * el de 24 h ya está marcado como mandado, y el que se mandó hablaba de
     * otro momento. En silencio, y se descubre cuando alguien no llega.
     */
    const cita = await nueva('14:00', '14:30');
    await en((c) => marcarAvisoEnviado(c, { tenantId: tenant, appointmentId: cita.id, aviso: '24h' }));

    const antes = await admin.query(
      'SELECT status, reminders_sent FROM appointments WHERE id = $1',
      [cita.id],
    );
    expect(antes.rows[0].status).toBe('reminded');
    expect(antes.rows[0].reminders_sent).toEqual(['24h']);

    await en((c) =>
      reagendarCita(c, { tenantId: tenant, appointmentId: cita.id, inicio: H('16:00'), fin: H('16:30') }),
    );

    const despues = await admin.query(
      'SELECT status, reminders_sent FROM appointments WHERE id = $1',
      [cita.id],
    );
    expect(despues.rows[0].reminders_sent).toEqual([]);
    // Y vuelve de `reminded` a `confirmed`: «ya le recordamos» deja de ser
    // cierto en el momento en que la hora cambia.
    expect(despues.rows[0].status).toBe('confirmed');

    // La prueba de que sirve: el job la vuelve a tomar para la hora nueva.
    // 23,5 h antes y no 23: la ventana del aviso de 24 h es
    // `(ahora+23h, ahora+24h]`, así que a exactamente 23 h la cita cae en el
    // borde de abajo, que es abierto. El borde no es lo que esta prueba mide.
    const porRecordar = await en((c) =>
      citasPorRecordar(c, {
        tenantId: tenant,
        ahora: new Date(H('16:00').getTime() - 23.5 * 3600_000),
      }),
    );
    expect(porRecordar.map((p) => p.appointmentId)).toContain(cita.id);
  });

  it('no se mueve encima de otra cita del mismo dueño', async () => {
    const primera = await nueva('14:00', '14:30');
    await nueva('16:00', '16:30');
    await expect(
      en((c) =>
        reagendarCita(c, { tenantId: tenant, appointmentId: primera.id, inicio: H('16:15'), fin: H('16:45') }),
      ),
    ).rejects.toThrow(/se acaba de tomar/);
  });

  it('moverla a su propia hora no choca consigo misma', async () => {
    // El `id <> $3` del choque: sin eso, correr una cita quince minutos se
    // rechaza a sí misma y la función no sirve para lo único que hace.
    const cita = await nueva('14:00', '14:30');
    const movida = await en((c) =>
      reagendarCita(c, { tenantId: tenant, appointmentId: cita.id, inicio: H('14:15'), fin: H('14:45') }),
    );
    expect(new Date(movida.startsAt).toISOString()).toBe(H('14:15').toISOString());
  });

  it('una cita cancelada no se mueve: se agenda otra', async () => {
    const cita = await nueva('14:00', '14:30');
    await en((c) =>
      cambiarEstadoCita(c, { tenantId: tenant, appointmentId: cita.id, to: 'cancelled', motivo: 'no puede' }),
    );
    await expect(
      en((c) =>
        reagendarCita(c, { tenantId: tenant, appointmentId: cita.id, inicio: H('16:00'), fin: H('16:30') }),
      ),
    ).rejects.toThrow(/cancelada no se mueve/);
  });

  it('publica el evento con las DOS horas', async () => {
    const cita = await nueva('14:00', '14:30');
    await en((c) =>
      reagendarCita(c, { tenantId: tenant, appointmentId: cita.id, inicio: H('16:00'), fin: H('16:30') }),
    );
    const ev = await admin.query(
      `SELECT payload FROM outbox WHERE tenant_id = $1 AND name = 'appointment.rescheduled'`,
      [tenant],
    );
    expect(ev.rowCount).toBe(1);
    // Quien reaccione tiene que poder decir «de las 14:00 a las 16:00», no
    // solo «ahora es a las 16:00».
    expect(ev.rows[0].payload.startsAtAnterior).toBeTruthy();
    expect(new Date(ev.rows[0].payload.startsAtAnterior).toISOString()).toBe(H('14:00').toISOString());
    expect(new Date(ev.rows[0].payload.startsAt).toISOString()).toBe(H('16:00').toISOString());
  });

  it('sin conexión a Google lo dice, en vez de callarse', async () => {
    const cita = await nueva('14:00', '14:30');
    await admin.query(`UPDATE appointments SET google_event_id = 'ev-123' WHERE id = $1`, [cita.id]);
    const movida = await en((c) =>
      reagendarCita(c, { tenantId: tenant, appointmentId: cita.id, inicio: H('16:00'), fin: H('16:30') }),
    );
    // La cita se movió igual —acá primero y pase lo que pase allá, #700— y
    // queda escrito que en Google sigue en la hora vieja.
    expect(new Date(movida.startsAt).toISOString()).toBe(H('16:00').toISOString());
    expect(movida.googleSyncError).toMatch(/hora vieja/);
  });

  it('con conexión, MUEVE el evento en vez de cancelarlo y crear otro', async () => {
    // La diferencia la paga el cliente: cancelar y crear le manda dos correos
    // por algo que para él fue un cambio de hora.
    const moverEnGoogle = vi.fn(async () => null);
    const cita = await nueva('14:00', '14:30');
    await admin.query(`UPDATE appointments SET google_event_id = 'ev-123' WHERE id = $1`, [cita.id]);
    const movida = await en((c) =>
      reagendarCita(
        c,
        { tenantId: tenant, appointmentId: cita.id, inicio: H('16:00'), fin: H('16:30') },
        { moverEnGoogle },
      ),
    );
    expect(moverEnGoogle).toHaveBeenCalledWith(
      expect.objectContaining({ googleEventId: 'ev-123', inicio: H('16:00'), fin: H('16:30') }),
    );
    expect(movida.googleSyncError).toBeNull();
  });
});
