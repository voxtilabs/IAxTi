import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { extractMentions, quickReplyVariables, renderQuickReply } from '../domain/plantillas';
import {
  addInternalNote,
  createQuickReply,
  deleteQuickReply,
  listInternalNotes,
  listQuickReplies,
  searchConversations,
} from '../application/equipo';
import { receiveInbound, sendMessage } from '../application/conversations';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenant: string;
let conversacion: string;
const vendedora = randomUUID();
const colega = randomUUID();

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
    'GRANT SELECT, INSERT, UPDATE ON contacts, conversations, messages, assignments TO iaxti_app',
  );
  await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON quick_replies, internal_notes TO iaxti_app');
  await admin.query('GRANT SELECT ON tenants, user_roles TO iaxti_app');
  await admin.query('GRANT INSERT ON outbox TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('equipo-test') RETURNING id");
  tenant = t.rows[0].id;

  const res = await withTenant(app, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: '+56940000001',
      channel: 'simulador',
      body: 'Hola, necesito una cotización del plan familiar',
    }),
  );
  conversacion = res.conversation.id;
  await admin.query('UPDATE conversations SET owner_id = $2 WHERE id = $1', [conversacion, vendedora]);
  await withTenant(app, tenant, (c) =>
    sendMessage(c, {
      tenantId: tenant,
      conversationId: conversacion,
      authorKind: 'user',
      authorId: vendedora,
      body: 'Te mando los precios altiro',
    }),
  );
});

afterAll(async () => {
  await app.end();
  await admin.query('DELETE FROM internal_notes WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM quick_replies WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM assignments WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('plantillas (dominio)', () => {
  it('rellena variables y deja visibles las que faltan', () => {
    expect(renderQuickReply('Hola {nombre}, el total es {monto}', { nombre: 'María', monto: null }))
      .toBe('Hola María, el total es {monto}');
    expect(quickReplyVariables('Hola {nombre}, {nombre}: {monto}')).toEqual(['nombre', 'monto']);
    expect(extractMentions('ojo @caro.soto y @pedro con esto')).toEqual(['caro.soto', 'pedro']);
  });
});

describe('quick replies (rol de aplicación)', () => {
  it('conviven el atajo del negocio y el personal; el atajo se normaliza', async () => {
    await withTenant(app, tenant, (c) =>
      createQuickReply(c, { tenantId: tenant, shortcut: '/Gracias', body: '¡Gracias por escribirnos, {nombre}!' }),
    );
    await withTenant(app, tenant, (c) =>
      createQuickReply(c, { tenantId: tenant, shortcut: 'firma', body: 'Saludos, María', userId: vendedora }),
    );
    const deVendedora = await withTenant(app, tenant, (c) => listQuickReplies(c, tenant, vendedora));
    expect(deVendedora.map((q) => q.shortcut)).toEqual(['firma', 'gracias']);
    const deColega = await withTenant(app, tenant, (c) => listQuickReplies(c, tenant, colega));
    expect(deColega.map((q) => q.shortcut)).toEqual(['gracias']); // la firma es personal
  });

  it('el atajo duplicado se rechaza con voz Pulso y borrar exige ser dueño', async () => {
    await expect(
      withTenant(app, tenant, (c) =>
        createQuickReply(c, { tenantId: tenant, shortcut: 'gracias', body: 'otro' }),
      ),
    ).rejects.toThrow(/Ya existe un atajo/);

    const mios = await withTenant(app, tenant, (c) => listQuickReplies(c, tenant, vendedora));
    const firma = mios.find((q) => q.shortcut === 'firma')!;
    await expect(
      withTenant(app, tenant, (c) =>
        deleteQuickReply(c, { tenantId: tenant, id: firma.id, userId: colega }),
      ),
    ).rejects.toThrow(/no es tuyo/);
    await withTenant(app, tenant, (c) =>
      deleteQuickReply(c, { tenantId: tenant, id: firma.id, userId: vendedora }),
    );
  });
});

describe('notas internas y búsqueda (rol de aplicación)', () => {
  it('la nota queda fuera de messages (jamás se envía) y guarda menciones', async () => {
    const nota = await withTenant(app, tenant, (c) =>
      addInternalNote(c, {
        tenantId: tenant,
        conversationId: conversacion,
        authorId: vendedora,
        body: 'Ojo: pidió factura para su empresa',
        mentions: [colega],
      }),
    );
    expect(nota.mentions).toEqual([colega]);
    const notas = await withTenant(app, tenant, (c) => listInternalNotes(c, tenant, conversacion));
    expect(notas).toHaveLength(1);
    const mensajes = await admin.query(
      'SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1',
      [conversacion],
    );
    expect(mensajes.rows[0].n).toBe(2); // la nota NO es un mensaje
  });

  it('la búsqueda en español encuentra por raíz en mensajes y notas', async () => {
    // "cotizar" debe encontrar "cotización" (stemming español).
    const porMensaje = await withTenant(app, tenant, (c) =>
      searchConversations(c, { tenantId: tenant, query: 'cotizar' }),
    );
    expect(porMensaje.some((h) => h.kind === 'mensaje' && h.conversationId === conversacion)).toBe(true);
    expect(porMensaje[0].snippet).toContain('<b>');

    const porNota = await withTenant(app, tenant, (c) =>
      searchConversations(c, { tenantId: tenant, query: 'factura empresa' }),
    );
    expect(porNota.some((h) => h.kind === 'nota')).toBe(true);
  });

  it('sin read_all no aparecen conversaciones de colegas', async () => {
    const ajeno = await withTenant(app, tenant, (c) =>
      searchConversations(c, { tenantId: tenant, query: 'cotizar', ownerScope: colega }),
    );
    expect(ajeno).toEqual([]); // la conversación es de la vendedora
    const propio = await withTenant(app, tenant, (c) =>
      searchConversations(c, { tenantId: tenant, query: 'cotizar', ownerScope: vendedora }),
    );
    expect(propio.length).toBeGreaterThan(0);
  });
});
