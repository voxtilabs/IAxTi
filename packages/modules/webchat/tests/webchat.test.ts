import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { listInbox, sendMessage } from '@iaxti/module-conversations';
import {
  createWidget,
  domainAllowed,
  getSessionReplies,
  postVisitorMessage,
  setWidgetActive,
  startSession,
} from '../application/webchat';
import type { Widget } from '../application/webchat';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenant: string;
let widget: Widget;

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
  await admin.query(
    'GRANT SELECT, INSERT, UPDATE ON contacts, conversations, messages, assignments, channel_accounts, webchat_widgets, webchat_sessions, tenants, user_roles TO iaxti_app',
  );
  await admin.query('GRANT INSERT ON outbox TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('webchat-test') RETURNING id");
  tenant = t.rows[0].id;
  widget = await withTenant(app, tenant, (c) =>
    createWidget(c, { tenantId: tenant, allowedDomain: 'https://Tunegocio.cl/planes' }),
  );
});

afterAll(async () => {
  await app.end();
  for (const tabla of ['webchat_sessions', 'webchat_widgets', 'assignments', 'messages', 'conversations', 'contacts', 'channel_accounts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('widget (#46)', () => {
  it('nace con el dominio normalizado y su cuenta de canal activa', async () => {
    expect(widget.allowedDomain).toBe('tunegocio.cl');
    const cuenta = await admin.query('SELECT kind, state FROM channel_accounts WHERE id = $1', [
      widget.channelAccountId,
    ]);
    expect(cuenta.rows[0]).toEqual({ kind: 'webchat', state: 'active' });
  });

  it('domainAllowed acepta el dominio y subdominios; rechaza el resto', () => {
    expect(domainAllowed(widget, 'https://tunegocio.cl/contacto')).toBe(true);
    expect(domainAllowed(widget, 'https://www.tunegocio.cl')).toBe(true);
    expect(domainAllowed(widget, 'https://otrositio.cl')).toBe(false);
    expect(domainAllowed(widget, 'https://tunegocio.cl.malo.com')).toBe(false);
    expect(domainAllowed(widget, undefined)).toBe(false);
    expect(domainAllowed(widget, 'no-es-url')).toBe(false);
  });
});

describe('el visitante (#46)', () => {
  it('primero anónimo → identidad antes del segundo → todo cae en la MISMA bandeja', async () => {
    const session = await withTenant(app, tenant, (c) =>
      startSession(c, { tenantId: tenant, widgetId: widget.id }),
    );

    const primero = await withTenant(app, tenant, (c) =>
      postVisitorMessage(c, { widget, sessionId: session.id, body: 'Hola, ¿tienen planes?' }),
    );
    expect(primero.status).toBe('pending'); // el primero espera en la sesión

    const segundo = await withTenant(app, tenant, (c) =>
      postVisitorMessage(c, { widget, sessionId: session.id, body: '¿Hola?' }),
    );
    expect(segundo.status).toBe('need_identity'); // sin identidad no hay segundo

    // Identidad con SOLO correo: el contacto web nace sin teléfono.
    const identificado = await withTenant(app, tenant, (c) =>
      postVisitorMessage(c, {
        widget,
        sessionId: session.id,
        body: 'Soy María, quiero el plan Crece',
        visitor: { name: 'María Web', email: 'Maria@Correo.cl' },
      }),
    );
    expect(identificado.status).toBe('delivered');

    const contacto = await admin.query(
      `SELECT name, phone, email, origin FROM contacts WHERE tenant_id = $1 AND email = 'maria@correo.cl'`,
      [tenant],
    );
    expect(contacto.rows[0]).toEqual({
      name: 'María Web',
      phone: null,
      email: 'maria@correo.cl',
      origin: 'webchat',
    });

    // El pendiente se volcó EN ORDEN antes del mensaje nuevo.
    const mensajes = await admin.query(
      `SELECT m.body FROM messages m WHERE m.tenant_id = $1 AND m.conversation_id = $2 ORDER BY m.created_at`,
      [tenant, identificado.conversationId],
    );
    expect(mensajes.rows.map((r) => r.body)).toEqual([
      'Hola, ¿tienen planes?',
      'Soy María, quiero el plan Crece',
    ]);

    // La MISMA bandeja: aparece en listInbox con canal webchat.
    const bandeja = await withTenant(app, tenant, (c) => listInbox(c, tenant));
    const fila = bandeja.items.find((i) => i.id === identificado.conversationId);
    expect(fila?.channel).toBe('webchat');
    expect(fila?.contactName).toBe('María Web');

    // Ya identificada: el siguiente entra directo a la misma conversación.
    const siguiente = await withTenant(app, tenant, (c) =>
      postVisitorMessage(c, { widget, sessionId: session.id, body: '¿Precio?' }),
    );
    expect(siguiente.status).toBe('delivered');
    expect(siguiente.conversationId).toBe(identificado.conversationId);

    // La respuesta del equipo llega por el sondeo, con cursor.
    await withTenant(app, tenant, (c) =>
      sendMessage(c, {
        tenantId: tenant,
        conversationId: identificado.conversationId!,
        authorKind: 'user',
        body: '¡Hola María! El plan Crece parte en...',
      }),
    );
    const respuestas = await withTenant(app, tenant, (c) =>
      getSessionReplies(c, { widget, sessionId: session.id }),
    );
    expect(respuestas).toHaveLength(1);
    expect(respuestas[0].body).toContain('plan Crece');
    const despues = await withTenant(app, tenant, (c) =>
      getSessionReplies(c, {
        widget,
        sessionId: session.id,
        afterIso: respuestas[0].createdAt.toISOString(),
      }),
    );
    expect(despues).toEqual([]);
  });

  it('apagar el widget lo desactiva; el historial queda intacto', async () => {
    const apagado = await withTenant(app, tenant, (c) =>
      setWidgetActive(c, { tenantId: tenant, widgetId: widget.id, active: false }),
    );
    expect(apagado.active).toBe(false);
    const historial = await admin.query(
      'SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1',
      [tenant],
    );
    expect(historial.rows[0].n).toBeGreaterThan(0); // nada se borra
  });
});
