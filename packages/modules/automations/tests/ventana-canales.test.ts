import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import { createRule } from '../application/rules';
import { runRule } from '../application/engine';
import type { Rule } from '../application/rules';

/**
 * Las automatizaciones sobre canales que NO son WhatsApp.
 *
 * Dos leyes que el motor decía cumplir y no cumplía:
 *  - lo que sale por un proveedor tiene que pasar por la cola (si no, se
 *    marca `sent` un mensaje que nunca salió);
 *  - fuera de la ventana de mensajería no se manda: se salta con su motivo.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const TODOS = ['conversations', 'crm'];

let admin: Pool;
let tenant: string;
let conversacion: string;
let regla: Rule;
let encolados: string[] = [];

const deps = {
  activeModules: TODOS,
  enqueueOutbound: async (job: { messageId: string }) => {
    encolados.push(job.messageId);
  },
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('ventana-canales') RETURNING id");
  tenant = t.rows[0].id;
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: 'ig_17841400000000001',
      channel: 'instagram',
      body: 'Hola, vi su historia',
    }),
  );
  conversacion = res.conversation.id;
  regla = await withTenant(admin, tenant, (c) =>
    createRule(c, {
      tenantId: tenant,
      name: 'Responder por Instagram',
      trigger: { kind: 'event', event: 'agent.escalated' },
      conditions: [],
      actions: [{ kind: 'send_message', params: { body: '¡Gracias por escribirnos!' } }],
      actor: 'test',
    }),
  );
});

afterAll(async () => {
  // El tenant NO se borra: `audit_log` es append-only y no cascadea (ADR-0006).
  // Pero sus eventos sí: un outbox con pendientes ajenos rompe el test del
  // despachador, que cuenta los ticks de TODA la tabla.
  await admin.query(
    'DELETE FROM processed_events USING outbox WHERE outbox.id = processed_events.event_id AND outbox.tenant_id = $1',
    [tenant],
  );
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

describe('automatizaciones fuera de WhatsApp', () => {
  it('Instagram dentro de la ventana: el mensaje va a la COLA, no se da por enviado', async () => {
    encolados = [];
    const res = await withTenant(admin, tenant, (c) =>
      runRule(
        c,
        { tenantId: tenant, rule: regla, objectKind: 'conversation', objectId: conversacion, dedupeKey: `${regla.id}:ig1` },
        deps,
      ),
    );
    expect(res?.status).toBe('ok');
    expect(res?.detail).toContain('cola');
    const msg = await admin.query(
      `SELECT id, delivery_status FROM messages
        WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'out' ORDER BY seq DESC LIMIT 1`,
      [tenant, conversacion],
    );
    // Antes del arreglo esto era 'sent' y `encolados` quedaba vacío: el
    // cliente veía un mensaje entregado que nunca existió.
    expect(msg.rows[0].delivery_status).toBe('queued');
    expect(encolados).toEqual([msg.rows[0].id]);
  });

  it('Instagram fuera de la ventana: se salta con su motivo y NO escribe mensaje', async () => {
    encolados = [];
    await admin.query(
      `UPDATE conversations SET last_inbound_at = now() - interval '30 hours' WHERE id = $1`,
      [conversacion],
    );
    const antes = await admin.query(
      `SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'out'`,
      [tenant, conversacion],
    );
    const res = await withTenant(admin, tenant, (c) =>
      runRule(
        c,
        { tenantId: tenant, rule: regla, objectKind: 'conversation', objectId: conversacion, dedupeKey: `${regla.id}:ig2` },
        deps,
      ),
    );
    expect(res?.status).toBe('skipped');
    expect(res?.detail).toContain('ventana');
    expect(encolados).toEqual([]);
    const despues = await admin.query(
      `SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'out'`,
      [tenant, conversacion],
    );
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });
});
