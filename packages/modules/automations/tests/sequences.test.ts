import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import {
  createSequence,
  enroll,
  enrollmentsForContact,
  sequenceConsumers,
  stopEnrollment,
  sweepSequences,
  validateSteps,
} from '../application/sequences';
import type { Sequence } from '../application/sequences';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

const TODOS = ['conversations', 'crm'];

let admin: Pool;
let tenant: string;
let secuencia: Sequence;

async function conversacionNueva(phone: string) {
  return withTenant(admin, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, phone, channel: 'simulador', body: 'hola, ¿precios?' }),
  );
}

async function vencer(enrollmentId: string) {
  await admin.query(
    `UPDATE sequence_enrollments SET next_run_at = now() - interval '1 minute' WHERE id = $1`,
    [enrollmentId],
  );
}

async function emitir(name: string, payload: Record<string, unknown>) {
  const client = await admin.connect();
  try {
    const consumer = sequenceConsumers().find((c) => c.event === name)!;
    await consumer.handler(
      { id: 1, name, tenantId: tenant, payload, actor: 'system', requestId: null, version: 1, occurredAt: new Date() } as never,
      client,
    );
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('sequences-test') RETURNING id");
  tenant = t.rows[0].id;
  secuencia = await withTenant(admin, tenant, (c) =>
    createSequence(c, {
      tenantId: tenant,
      name: 'Seguimiento cotización',
      steps: [
        { afterHours: 0, action: { kind: 'send_message', params: { body: '¿Pudiste revisar la cotización?' } } },
        { afterHours: 48, onlyIfNoReply: true, action: { kind: 'send_message', params: { body: '¿Seguimos? Quedo atento.' } } },
        { afterHours: 96, onlyIfNoReply: true, action: { kind: 'add_note', params: { body: 'Cliente frío: decidir si cerrar.' } } },
      ],
      actor: 'test',
    }),
  );
});

afterAll(async () => {
  for (const tabla of ['sequence_enrollments', 'sequences', 'rule_runs', 'rules', 'internal_notes', 'assignments', 'messages', 'conversations', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('secuencias (#63)', () => {
  it('la validación exige pasos, esperas y mensajes con texto', () => {
    expect(() => validateSteps([])).toThrow(/paso/);
    expect(() => validateSteps([{ afterHours: -1, action: { kind: 'add_note', params: {} } }])).toThrow(/espera/);
    expect(() =>
      validateSteps([{ afterHours: 0, action: { kind: 'send_message', params: { body: ' ' } } }]),
    ).toThrow(/vacío/);
  });

  it('inscribir programa el primer paso; doble inscripción viva es error claro', async () => {
    const res = await conversacionNueva('+56911110001');
    const e = await withTenant(admin, tenant, (c) =>
      enroll(c, { tenantId: tenant, sequenceId: secuencia.id, conversationId: res.conversation.id, actor: randomUUID() }),
    );
    expect(e.status).toBe('running');
    expect(e.nextRunAt).not.toBeNull();
    await expect(
      withTenant(admin, tenant, (c) =>
        enroll(c, { tenantId: tenant, sequenceId: secuencia.id, conversationId: res.conversation.id, actor: randomUUID() }),
      ),
    ).rejects.toThrow(/ya está/);

    const evento = await admin.query(
      `SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1 AND name = 'sequence.started'`,
      [tenant],
    );
    expect(evento.rows[0].n).toBe(1);

    // El estado queda visible en la ficha del contacto.
    const ficha = await withTenant(admin, tenant, (c) =>
      enrollmentsForContact(c, tenant, res.contact.id),
    );
    expect(ficha[0]).toMatchObject({ status: 'running', currentStep: 0, totalSteps: 3, sequenceName: 'Seguimiento cotización' });
  });

  it('el tick ejecuta el paso vencido (mensaje real) y programa el siguiente', async () => {
    const filas = await admin.query(
      `SELECT id, conversation_id FROM sequence_enrollments WHERE tenant_id = $1 AND status = 'running'`,
      [tenant],
    );
    await vencer(filas.rows[0].id);
    const corridos = await sweepSequences(admin, { activeModules: TODOS });
    expect(corridos).toBe(1);

    const msg = await admin.query(
      `SELECT body, author_kind, delivery_status FROM messages
        WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'out'`,
      [tenant, filas.rows[0].conversation_id],
    );
    expect(msg.rows[0]).toMatchObject({ author_kind: 'system', delivery_status: 'sent' });
    expect(msg.rows[0].body).toContain('cotización');

    const e = await admin.query('SELECT current_step, status, next_run_at FROM sequence_enrollments WHERE id = $1', [filas.rows[0].id]);
    expect(e.rows[0].current_step).toBe(1);
    expect(e.rows[0].status).toBe('running');
    expect(new Date(e.rows[0].next_run_at).getTime()).toBeGreaterThan(Date.now() + 40 * 3600_000);
  });

  it('se corta SOLA cuando el cliente responde (consumer de message.received)', async () => {
    const filas = await admin.query(
      `SELECT id, conversation_id FROM sequence_enrollments WHERE tenant_id = $1 AND status = 'running'`,
      [tenant],
    );
    await emitir('message.received', { conversationId: filas.rows[0].conversation_id, messageId: randomUUID() });
    const e = await admin.query('SELECT status, stop_reason FROM sequence_enrollments WHERE id = $1', [filas.rows[0].id]);
    expect(e.rows[0]).toEqual({ status: 'stopped', stop_reason: 'el cliente respondió' });
    const evento = await admin.query(
      `SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1 AND name = 'sequence.stopped'`,
      [tenant],
    );
    expect(evento.rows[0].n).toBe(1);
  });

  it('onlyIfNoReply: si el cliente ya respondió, el paso corta en vez de correr', async () => {
    const res = await conversacionNueva('+56911110002');
    const e = await withTenant(admin, tenant, (c) =>
      enroll(c, { tenantId: tenant, sequenceId: secuencia.id, conversationId: res.conversation.id, actor: randomUUID() }),
    );
    // Salta al paso 2 (onlyIfNoReply) con un entrante posterior a la inscripción.
    await admin.query('UPDATE sequence_enrollments SET current_step = 1 WHERE id = $1', [e.id]);
    await withTenant(admin, tenant, (c) =>
      receiveInbound(c, { tenantId: tenant, phone: '+56911110002', channel: 'simulador', body: 'sí, la vi' }),
    );
    await vencer(e.id);
    await sweepSequences(admin, { activeModules: TODOS });
    const fila = await admin.query('SELECT status, stop_reason FROM sequence_enrollments WHERE id = $1', [e.id]);
    expect(fila.rows[0].status).toBe('stopped');
    expect(fila.rows[0].stop_reason).toContain('respondió');
  });

  it('el último paso completa la secuencia; y detener a mano funciona', async () => {
    const res = await conversacionNueva('+56911110003');
    const e = await withTenant(admin, tenant, (c) =>
      enroll(c, { tenantId: tenant, sequenceId: secuencia.id, conversationId: res.conversation.id, actor: randomUUID() }),
    );
    await admin.query('UPDATE sequence_enrollments SET current_step = 2 WHERE id = $1', [e.id]);
    await vencer(e.id);
    await sweepSequences(admin, { activeModules: TODOS });
    const fila = await admin.query('SELECT status FROM sequence_enrollments WHERE id = $1', [e.id]);
    expect(fila.rows[0].status).toBe('completed');
    const nota = await admin.query(
      `SELECT count(*)::int AS n FROM internal_notes WHERE tenant_id = $1 AND body LIKE 'Cliente frío%'`,
      [tenant],
    );
    expect(nota.rows[0].n).toBe(1);

    // Re-inscribir tras terminar SÍ se puede; y detener a mano corta.
    const e2 = await withTenant(admin, tenant, (c) =>
      enroll(c, { tenantId: tenant, sequenceId: secuencia.id, conversationId: res.conversation.id, actor: randomUUID() }),
    );
    await withTenant(admin, tenant, (c) =>
      stopEnrollment(c, { tenantId: tenant, enrollmentId: e2.id, actor: 'test' }),
    );
    const parada = await admin.query('SELECT status, stop_reason FROM sequence_enrollments WHERE id = $1', [e2.id]);
    expect(parada.rows[0]).toEqual({ status: 'stopped', stop_reason: 'detenida a mano' });
  });

  it('módulo apagado: la secuencia en curso se DETIENE guardando el porqué', async () => {
    const res = await conversacionNueva('+56911110004');
    const e = await withTenant(admin, tenant, (c) =>
      enroll(c, { tenantId: tenant, sequenceId: secuencia.id, conversationId: res.conversation.id, actor: randomUUID() }),
    );
    await vencer(e.id);
    await sweepSequences(admin, { activeModules: [] }); // conversations apagado
    const fila = await admin.query('SELECT status, stop_reason FROM sequence_enrollments WHERE id = $1', [e.id]);
    expect(fila.rows[0].status).toBe('stopped');
    expect(fila.rows[0].stop_reason).toContain('apagado');
    // La definición de la secuencia sigue guardada tal cual.
    const seq = await admin.query('SELECT count(*)::int AS n FROM sequences WHERE tenant_id = $1', [tenant]);
    expect(seq.rows[0].n).toBe(1);
  });

  it('paso de mensaje por WhatsApp fuera de ventana: se salta con aviso (plantillas #44)', async () => {
    const res = await conversacionNueva('+56911110005');
    await admin.query(`UPDATE conversations SET channel = 'whatsapp', last_inbound_at = now() - interval '2 days' WHERE id = $1`, [res.conversation.id]);
    const e = await withTenant(admin, tenant, (c) =>
      enroll(c, { tenantId: tenant, sequenceId: secuencia.id, conversationId: res.conversation.id, actor: randomUUID() }),
    );
    await vencer(e.id);
    await sweepSequences(admin, { activeModules: TODOS });
    const fila = await admin.query('SELECT current_step, stop_reason FROM sequence_enrollments WHERE id = $1', [e.id]);
    expect(fila.rows[0].current_step).toBe(1); // avanzó sin enviar
    expect(fila.rows[0].stop_reason).toContain('ventana');
    const msg = await admin.query(
      `SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'out'`,
      [tenant, res.conversation.id],
    );
    expect(msg.rows[0].n).toBe(0); // nada salió fuera de ventana
  });
});
