import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { verifyChain } from '@iaxti/module-audit';
import { agendar, cambiarEstadoCita } from '../application/agenda';

let pool: Pool;
let tenantId: string;
let contactId: string;
let ownerId: string;
const inicio = new Date('2027-08-02T14:00:00Z');
const fin = new Date('2027-08-02T15:00:00Z');
const en = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, tenantId, fn);
const datos = () => ({ tenantId, contactId, ownerId, inicio, fin, confirmada: true, actor: ownerId, requestId: 'req-reserva' });

beforeAll(async () => { pool = createPool(); await runMigrations(pool); });
beforeEach(async () => {
  tenantId = (await pool.query("INSERT INTO tenants (name) VALUES ('agenda-concurrente') RETURNING id")).rows[0].id;
  contactId = (await pool.query("INSERT INTO contacts (tenant_id, name, origin) VALUES ($1, 'Prueba', 'manual') RETURNING id", [tenantId])).rows[0].id;
  ownerId = randomUUID();
});
afterAll(async () => { await pool.end(); });

async function abrir(): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  return c;
}

/** Observa el bloqueo real, sin suponer su tipo ni dormir un tiempo arbitrario. */
async function terminaOBloquea(p: Promise<unknown>, pid: number) {
  let terminado = false;
  void p.then(() => { terminado = true; }, () => { terminado = true; });
  const limite = Date.now() + 4000;
  while (!terminado && Date.now() < limite) {
    const r = await pool.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS bloqueado', [pid]);
    if (r.rows[0].bloqueado) return;
  }
  if (!terminado) throw new Error('La segunda transacción no terminó ni esperó a la primera.');
}

describe('reservas y estados concurrentes (#373)', () => {
  it.each(['normal', 'mayúsculas', 'sin-guiones'])('solo reserva una vez la misma hora (UUID %s)', async formato => {
    const a = await abrir();
    const b = await abrir();
    let segunda: Promise<unknown> | undefined;
    try {
      const primera = await agendar(a, datos());
      const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const owner = formato === 'mayúsculas' ? ownerId.toUpperCase() : formato === 'sin-guiones' ? ownerId.replaceAll('-', '') : ownerId;
      segunda = agendar(b, { ...datos(), ownerId: owner });
      await terminaOBloquea(segunda, pid);
      await a.query('COMMIT');
      await expect(segunda).rejects.toThrow(/se acaba de tomar/);
      await b.query('ROLLBACK');
      const citas = await pool.query('SELECT id FROM appointments WHERE tenant_id = $1', [tenantId]);
      expect(citas.rows).toEqual([{ id: primera.id }]);
      expect((await pool.query("SELECT id FROM outbox WHERE tenant_id = $1 AND name = 'appointment.created'", [tenantId])).rowCount).toBe(1);
    } finally {
      await a.query('ROLLBACK'); await b.query('ROLLBACK');
      await segunda?.catch(() => {});
      a.release(); b.release();
    }
  });
  it('una transición concurrente no pisa una cancelación ya decidida', async () => {
    const cita = await en(c => agendar(c, datos()));
    const a = await abrir();
    const b = await abrir();
    let segunda: Promise<unknown> | undefined;
    try {
      await cambiarEstadoCita(a, { tenantId, appointmentId: cita.id, to: 'cancelled', actor: ownerId });
      const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      segunda = cambiarEstadoCita(b, { tenantId, appointmentId: cita.id, to: 'attended', actor: ownerId });
      await terminaOBloquea(segunda, pid);
      await a.query('COMMIT');
      await expect(segunda).rejects.toThrow(/Transición de cita inválida/);
      await b.query('ROLLBACK');
      expect((await pool.query('SELECT status FROM appointments WHERE id = $1', [cita.id])).rows[0].status).toBe('cancelled');
      expect((await pool.query("SELECT id FROM outbox WHERE tenant_id = $1 AND name = 'appointment.attended'", [tenantId])).rowCount).toBe(0);
    } finally {
      await a.query('ROLLBACK'); await b.query('ROLLBACK');
      await segunda?.catch(() => {});
      a.release(); b.release();
    }
  });
  it('mantiene horas contiguas y responsables diferentes', async () => {
    const resultados = await Promise.all([
      en(c => agendar(c, datos())),
      en(c => agendar(c, { ...datos(), inicio: fin, fin: new Date('2027-08-02T16:00:00Z') })),
      en(c => agendar(c, { ...datos(), ownerId: randomUUID() })),
    ]);
    expect(new Set(resultados.map(r => r.id)).size).toBe(3);
  });
  it('el mismo responsable en otro tenant no espera una reserva sin commit', async () => {
    const otro = (await pool.query("INSERT INTO tenants (name) VALUES ('otra-agenda') RETURNING id")).rows[0].id;
    const contacto = (await pool.query("INSERT INTO contacts (tenant_id, origin) VALUES ($1, 'manual') RETURNING id", [otro])).rows[0].id;
    const a = await abrir();
    const b = await abrir();
    let segunda: Promise<unknown> | undefined;
    try {
      await agendar(a, datos());
      await b.query("SELECT set_config('app.tenant_id', $1, true)", [otro]);
      const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let completa = false;
      segunda = agendar(b, { ...datos(), tenantId: otro, contactId: contacto }).then(r => { completa = true; return r; });
      await terminaOBloquea(segunda, pid);
      expect(completa).toBe(true);
      await b.query('COMMIT'); await a.query('COMMIT');
    } finally {
      await a.query('ROLLBACK'); await b.query('ROLLBACK');
      await segunda?.catch(() => {});
      a.release(); b.release();
    }
  });
  it('fechas inválidas no llegan a PostgreSQL ni generan eventos', async () => {
    await expect(en(c => agendar(c, { ...datos(), inicio: new Date('inválido') }))).rejects.toThrow(/fechas de la cita/);
    expect((await pool.query('SELECT id FROM appointments WHERE tenant_id = $1', [tenantId])).rowCount).toBe(0);
  });
  it('el rol sin BYPASSRLS agenda y audita, pero no cambia una cita de otro tenant', async () => {
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_calendar_test') THEN
        CREATE ROLE iaxti_calendar_test LOGIN PASSWORD 'iaxti_calendar_test' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$`);
    await pool.query('GRANT USAGE ON SCHEMA public TO iaxti_calendar_test');
    await pool.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO iaxti_calendar_test');
    await pool.query('GRANT SELECT, INSERT, UPDATE ON appointments TO iaxti_calendar_test');
    await pool.query('GRANT SELECT, INSERT ON audit_log TO iaxti_calendar_test');
    await pool.query('GRANT INSERT ON outbox TO iaxti_calendar_test');
    const app = createPool(process.env.DATABASE_URL!.replace(/\/\/[^@]+@/, '//iaxti_calendar_test:iaxti_calendar_test@'));
    try {
      expect((await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0])
        .toEqual({ rolsuper: false, rolbypassrls: false });
      const cita = await withTenant(app, tenantId, c => agendar(c, { ...datos(), actorKind: 'apikey' }));
      await expect(withTenant(app, randomUUID(), c => cambiarEstadoCita(c, { tenantId, appointmentId: cita.id, to: 'cancelled' })))
        .rejects.toThrow(/no existe/);
      expect((await pool.query('SELECT status FROM appointments WHERE id = $1', [cita.id])).rows[0].status).toBe('confirmed');
      expect((await pool.query('SELECT actor_kind FROM audit_log WHERE tenant_id = $1', [tenantId])).rows[0].actor_kind).toBe('apikey');
    } finally { await app.end(); }
  });
  it('reserva, cambio de estado y auditoría se confirman juntos', async () => {
    const cita = await en(c => agendar(c, datos()));
    await en(c => cambiarEstadoCita(c, { tenantId, appointmentId: cita.id, to: 'no_show', actor: ownerId, requestId: 'req-no-show' }));
    const registros = await pool.query('SELECT action, actor, request_id FROM audit_log WHERE tenant_id = $1 ORDER BY id', [tenantId]);
    expect(registros.rows).toEqual([
      { action: 'calendar.appointment.created', actor: ownerId, request_id: 'req-reserva' },
      { action: 'calendar.appointment.state_changed', actor: ownerId, request_id: 'req-no-show' },
    ]);
    expect((await en(c => verifyChain(c, tenantId))).valid).toBe(true);
  });
  it('rollback no deja cita, evento ni auditoría y libera la hora', async () => {
    await expect(en(async c => { await agendar(c, datos()); throw new Error('cancelar transacción'); })).rejects.toThrow('cancelar transacción');
    for (const table of ['appointments', 'outbox', 'audit_log']) {
      expect((await pool.query(`SELECT id FROM ${table} WHERE tenant_id = $1`, [tenantId])).rowCount).toBe(0);
    }
    expect((await en(c => agendar(c, datos()))).status).toBe('confirmed');
  });
});
