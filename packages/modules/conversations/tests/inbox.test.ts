import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { getConversationDetail, listInbox } from '../application/inbox';
import { assignConversation, receiveInbound, sendMessage } from '../application/conversations';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenant: string;
const vendedora = randomUUID();
const conversaciones: string[] = [];

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
        CREATE ROLE iaxti_app LOGIN PASSWORD 'iaxti_app';
      END IF;
    END $$
  `);
  await admin.query('GRANT USAGE ON SCHEMA public TO iaxti_app');
  await admin.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO iaxti_app');
  await admin.query(
    'GRANT SELECT, INSERT, UPDATE ON contacts, contact_identities, conversations, messages, assignments TO iaxti_app',
  );
  // `usage_meters`: desde #213 cada conversación que recibe algo cuenta como
  // activa del ciclo, y eso lo escribe el MISMO camino de entrada. El rol de
  // la aplicación necesita poder sumarlo o la bandeja deja de recibir.
  await admin.query('GRANT SELECT, INSERT, UPDATE ON usage_meters TO iaxti_app');
  await admin.query('GRANT INSERT ON outbox TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('inbox') RETURNING id");
  tenant = t.rows[0].id;

  // Tres conversaciones en orden: la primera lleva MÁS tiempo esperando.
  for (const [i, phone] of ['+56911110001', '+56911110002', '+56911110003'].entries()) {
    const res = await withTenant(app, tenant, (c) =>
      receiveInbound(c, { tenantId: tenant, phone, channel: 'simulador', body: `hola ${i}` }),
    );
    conversaciones.push(res.conversation.id);
  }
  // La tercera queda respondida (deja de estar "sin responder") y con dueña.
  await withTenant(app, tenant, (c) =>
    assignConversation(c, { tenantId: tenant, conversationId: conversaciones[2], toOwnerId: vendedora }),
  );
  await withTenant(app, tenant, (c) =>
    sendMessage(c, {
      tenantId: tenant,
      conversationId: conversaciones[2],
      authorKind: 'user',
      authorId: vendedora,
      body: 'ya te respondo',
    }),
  );
});

afterAll(async () => {
  await app.end();
  await admin.query('DELETE FROM assignments WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('bandeja: listado y ficha (RLS activa)', () => {
  it('por defecto ordena por actividad reciente y trae la ficha mínima', async () => {
    const { items } = await withTenant(app, tenant, (c) => listInbox(c, tenant));
    expect(items).toHaveLength(3);
    expect(items[0].id).toBe(conversaciones[2]); // la última con actividad
    expect(items[0].contactPhone).toBe('+56911110003');
    expect(items[0].unansweredSeconds).toBeNull(); // ya respondida
    expect(items[2].unansweredSeconds).toBeGreaterThanOrEqual(0);
  });

  it('"sin responder" muestra solo las que esperan, la más antigua primero', async () => {
    const { items } = await withTenant(app, tenant, (c) =>
      listInbox(c, tenant, { view: 'sin_responder' }),
    );
    expect(items.map((i) => i.id)).toEqual([conversaciones[0], conversaciones[1]]);
    expect(items[0].unansweredSeconds).toBeGreaterThanOrEqual(items[1].unansweredSeconds!);
  });

  it('el filtro "suyas más las sin dueño" no muestra las de colegas', async () => {
    const otra = randomUUID();
    const { items } = await withTenant(app, tenant, (c) =>
      listInbox(c, tenant, { ownerIdOrUnassigned: otra }),
    );
    expect(items.map((i) => i.id).sort()).toEqual([conversaciones[0], conversaciones[1]].sort());
  });

  it('pagina por cursor sin repetir ni saltarse', async () => {
    const p1 = await withTenant(app, tenant, (c) => listInbox(c, tenant, { limit: 2 }));
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await withTenant(app, tenant, (c) =>
      listInbox(c, tenant, { limit: 2, cursor: p1.nextCursor! }),
    );
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    const ids = [...p1.items, ...p2.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('la ficha trae contacto con consentimiento y la conversación', async () => {
    const detail = await withTenant(app, tenant, (c) =>
      getConversationDetail(c, tenant, conversaciones[0]),
    );
    expect(detail.contactPhone).toBe('+56911110001');
    expect(detail.contactOptedOutAt).toBeNull();
    expect(detail.state).toBe('new');
  });
});
