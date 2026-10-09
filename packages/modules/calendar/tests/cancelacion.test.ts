import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  agendar,
  cambiarEstadoCita,
  citasDesincronizadasConGoogle,
  definirDisponibilidad,
  motivosDeCancelacion,
} from '../application/agenda';

/**
 * El motivo de cancelación y el evento de Google (#700).
 *
 * `cancel_reason` se escribía en cada cancelación desde el primer día y ninguna
 * consulta lo devolvía: nadie podía contestar «¿por qué se nos cancelan las
 * visitas?», que para una inmobiliaria es la pregunta del mes.
 *
 * `google_event_id` es la otra mitad. **Hoy nadie la escribe** —la conexión con
 * Google es #57 y no existe— así que el issue se equivoca al afirmar que algo la
 * escribe. Lo que sí se puede construir ahora, y es lo que importa, es que el
 * día que #57 llegue cancelar acá no deje el evento vivo allá: el camino de
 * cancelación la lee, llama al puerto, y si no se pudo avisar lo DICE.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let contacto: string;
const duena = randomUUID();
const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);

const LUNES = '2027-04-05';

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (
    await admin.query(
      "INSERT INTO tenants (name, timezone) VALUES ('cancelaciones', 'America/Santiago') RETURNING id",
    )
  ).rows[0].id;
  contacto = (
    await admin.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin)
       VALUES ($1, 'Rocío', '+56988881234', 'whatsapp') RETURNING id`,
      [tenant],
    )
  ).rows[0].id;
  // Lunes de 09:00 a 18:00, citas de 30 sin respiro: hacen falta varios huecos
  // porque cada prueba cancela su propia cita.
  await en((c) =>
    definirDisponibilidad(c, {
      tenantId: tenant,
      ownerId: duena,
      weekday: 1,
      inicioMin: 540,
      finMin: 1080,
      duracion: 30,
      respiro: 0,
      anticipacionMin: 60,
    }),
  );
});

afterAll(async () => {
  for (const t of ['appointments', 'availability', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

let hora = 9;
/** Una cita confirmada, cada una en su propio hueco. */
async function unaCita(googleEventId?: string): Promise<string> {
  const inicio = new Date(`${LUNES}T${String(hora).padStart(2, '0')}:00:00-03:00`);
  hora += 1;
  const cita = await en((c) =>
    agendar(c, {
      tenantId: tenant,
      contactId: contacto,
      ownerId: duena,
      inicio,
      fin: new Date(inicio.getTime() + 30 * 60_000),
      actor: 'test',
    }),
  );
  if (googleEventId) {
    await admin.query('UPDATE appointments SET google_event_id = $2 WHERE id = $1', [
      cita.id,
      googleEventId,
    ]);
  }
  return cita.id;
}

describe('el motivo de la cancelación se lee (#700)', () => {
  it('la cita cancelada trae su motivo', async () => {
    const id = await unaCita();
    const cita = await en((c) =>
      cambiarEstadoCita(c, {
        tenantId: tenant,
        appointmentId: id,
        to: 'cancelled',
        motivo: 'el cliente avisó que no podía',
        actor: 'test',
      }),
    );
    expect(cita.status).toBe('cancelled');
    expect(cita.cancelReason, 'se escribía desde el día uno y no se devolvía').toBe(
      'el cliente avisó que no podía',
    );
  });

  it('se agrupan por motivo, con el más frecuente primero', async () => {
    for (const motivo of ['se arrepintió', 'se arrepintió', 'lo movimos de día']) {
      const id = await unaCita();
      await en((c) =>
        cambiarEstadoCita(c, { tenantId: tenant, appointmentId: id, to: 'cancelled', motivo }),
      );
    }
    const r = await en((c) =>
      motivosDeCancelacion(c, { tenantId: tenant, from: '2027-04-01', to: '2027-04-30' }),
    );
    expect(r.motivos[0]).toEqual({ motivo: 'se arrepintió', n: 2 });
    expect(r.motivos.map((m) => m.motivo)).toContain('lo movimos de día');
    expect(r.total).toBeGreaterThanOrEqual(4);
  });

  it('«sin motivo» se cuenta aparte y NO como un motivo', async () => {
    // Mezclarlo haría que el más frecuente fuera siempre ése, y la pantalla
    // diría que la razón número uno de las cancelaciones es «sin motivo».
    const id = await unaCita();
    await en((c) => cambiarEstadoCita(c, { tenantId: tenant, appointmentId: id, to: 'cancelled' }));
    const r = await en((c) =>
      motivosDeCancelacion(c, { tenantId: tenant, from: '2027-04-01', to: '2027-04-30' }),
    );
    expect(r.sinMotivo).toBeGreaterThanOrEqual(1);
    expect(r.motivos.map((m) => m.motivo)).not.toContain('sin motivo');
    // Y el total sí lo incluye: son cancelaciones que pasaron.
    expect(r.total).toBeGreaterThan(r.motivos.reduce((s, m) => s + m.n, 0) - 1);
  });

  it('un motivo en blanco cuenta como sin motivo, no como un motivo vacío', async () => {
    const id = await unaCita();
    await en((c) =>
      cambiarEstadoCita(c, { tenantId: tenant, appointmentId: id, to: 'cancelled', motivo: '   ' }),
    );
    const r = await en((c) =>
      motivosDeCancelacion(c, { tenantId: tenant, from: '2027-04-01', to: '2027-04-30' }),
    );
    expect(r.motivos.some((m) => m.motivo.trim() === '')).toBe(false);
  });

  it('fuera del rango no se cuenta', async () => {
    const r = await en((c) =>
      motivosDeCancelacion(c, { tenantId: tenant, from: '2026-01-01', to: '2026-01-31' }),
    );
    expect(r.total).toBe(0);
    expect(r.motivos).toEqual([]);
  });
});

describe('cancelar no deja el evento vivo en Google (#700)', () => {
  it('con integración: se le avisa a Google y no queda problema anotado', async () => {
    const id = await unaCita('evento-google-1');
    const cancelarEnGoogle = vi.fn().mockResolvedValue(null);
    const cita = await en((c) =>
      cambiarEstadoCita(
        c,
        { tenantId: tenant, appointmentId: id, to: 'cancelled', motivo: 'se cayó' },
        { cancelarEnGoogle },
      ),
    );
    expect(cancelarEnGoogle).toHaveBeenCalledWith(
      expect.objectContaining({ googleEventId: 'evento-google-1', appointmentId: id }),
    );
    expect(cita.googleSyncError).toBeNull();
  });

  it('si Google contesta error, la cita QUEDA cancelada y el problema queda dicho', async () => {
    // Criterio 4. Lo contrario —que un error de Google impida cancelar— sería
    // exactamente al revés de lo que alguien necesita cuando el cliente ya
    // avisó que no viene.
    const id = await unaCita('evento-google-2');
    const cancelarEnGoogle = vi.fn().mockResolvedValue('Google rechazó el borrado del evento.');
    const cita = await en((c) =>
      cambiarEstadoCita(
        c,
        { tenantId: tenant, appointmentId: id, to: 'cancelled' },
        { cancelarEnGoogle },
      ),
    );
    expect(cita.status, 'la cita se cancela pase lo que pase allá').toBe('cancelled');
    expect(cita.googleSyncError).toBe('Google rechazó el borrado del evento.');
  });

  it('si el puerto revienta, tampoco se pierde la cancelación', async () => {
    const id = await unaCita('evento-google-3');
    const cancelarEnGoogle = vi.fn().mockRejectedValue(new Error('se cayó la red'));
    const cita = await en((c) =>
      cambiarEstadoCita(
        c,
        { tenantId: tenant, appointmentId: id, to: 'cancelled' },
        { cancelarEnGoogle },
      ),
    );
    expect(cita.status).toBe('cancelled');
    expect(cita.googleSyncError).toContain('se cayó la red');
  });

  it('sin integración, una cita CON evento deja dicho que allá sigue viva', async () => {
    // Es el estado de hoy: #57 no existe, así que no hay a quién avisarle.
    // Callarlo sería dejar una hora ocupada que el vendedor ve libre.
    const id = await unaCita('evento-google-4');
    const cita = await en((c) =>
      cambiarEstadoCita(c, { tenantId: tenant, appointmentId: id, to: 'cancelled' }),
    );
    expect(cita.status).toBe('cancelled');
    expect(cita.googleSyncError).toContain('Google Calendar');
  });

  it('sin evento de Google no se inventa un problema: criterio 3', async () => {
    // La mayoría de las citas están así, y tienen que seguir funcionando igual.
    const id = await unaCita();
    const cancelarEnGoogle = vi.fn();
    const cita = await en((c) =>
      cambiarEstadoCita(
        c,
        { tenantId: tenant, appointmentId: id, to: 'cancelled' },
        { cancelarEnGoogle },
      ),
    );
    expect(cancelarEnGoogle).not.toHaveBeenCalled();
    expect(cita.googleSyncError).toBeNull();
  });

  it('las desincronizadas se pueden listar: si no, el error no sirve de nada', async () => {
    const lista = await en((c) => citasDesincronizadasConGoogle(c, tenant));
    expect(lista.length).toBeGreaterThanOrEqual(3);
    expect(lista.every((d) => d.problema.length > 0)).toBe(true);
  });

  it('confirmar no toca nada de Google: solo cancelar lo necesita', async () => {
    const id = await unaCita('evento-google-5');
    const cancelarEnGoogle = vi.fn();
    const cita = await en((c) =>
      cambiarEstadoCita(
        c,
        { tenantId: tenant, appointmentId: id, to: 'confirmed' },
        { cancelarEnGoogle },
      ),
    );
    expect(cancelarEnGoogle).not.toHaveBeenCalled();
    expect(cita.googleSyncError).toBeNull();
  });
});
