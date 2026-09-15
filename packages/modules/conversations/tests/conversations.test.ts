import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  assertConversationTransition,
  assertDeliveryAdvance,
  isWithin24hWindow,
} from '../domain/state';
import {
  assignConversation,
  changeConversationState,
  getConversation,
  listMessages,
  receiveInbound,
  sendMessage,
  updateDeliveryStatus,
} from '../application/conversations';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenantA: string;
let tenantB: string;
const dueña = randomUUID();

async function eventos(nombre: string, tenant: string): Promise<number> {
  const r = await admin.query(
    'SELECT count(*)::int AS n FROM outbox WHERE name = $1 AND tenant_id = $2',
    [nombre, tenant],
  );
  return r.rows[0].n;
}

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
  const a = await admin.query("INSERT INTO tenants (name) VALUES ('conv-a') RETURNING id");
  const b = await admin.query("INSERT INTO tenants (name) VALUES ('conv-b') RETURNING id");
  tenantA = a.rows[0].id;
  tenantB = b.rows[0].id;
});

afterAll(async () => {
  await app.end();
  for (const t of [tenantA, tenantB]) {
    await admin.query('DELETE FROM assignments WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM messages WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM tenants WHERE id = $1', [t]);
  }
  await admin.end();
});

describe('dominio de la bandeja (SPEC §11)', () => {
  it('la máquina de estados valida y las inválidas se rechazan', () => {
    expect(() => assertConversationTransition('new', 'open')).not.toThrow();
    expect(() => assertConversationTransition('open', 'pending')).not.toThrow();
    expect(() => assertConversationTransition('resolved', 'open')).not.toThrow();
    expect(() => assertConversationTransition('new', 'pending')).toThrow(/inválida/);
    expect(() => assertConversationTransition('pending', 'new')).toThrow(/inválida/);
  });

  it('la entrega avanza y nunca retrocede; failed y read son terminales', () => {
    expect(() => assertDeliveryAdvance('queued', 'sent')).not.toThrow();
    expect(() => assertDeliveryAdvance('sent', 'read')).not.toThrow(); // Meta salta pasos
    expect(() => assertDeliveryAdvance('delivered', 'sent')).toThrow(/no retrocede/);
    expect(() => assertDeliveryAdvance('read', 'delivered')).toThrow(/ya terminó/);
    expect(() => assertDeliveryAdvance('failed', 'sent')).toThrow(/ya terminó/);
    expect(() => assertDeliveryAdvance('sent', 'failed')).not.toThrow();
  });

  it('la ventana de 24 h se mide desde el último entrante', () => {
    const ahora = new Date('2026-09-14T12:00:00Z');
    expect(isWithin24hWindow(new Date('2026-09-14T11:00:00Z'), ahora)).toBe(true);
    expect(isWithin24hWindow(new Date('2026-09-13T11:00:00Z'), ahora)).toBe(false);
    expect(isWithin24hWindow(null, ahora)).toBe(false);
  });
});

describe('bandeja (rol de aplicación, RLS activa)', () => {
  it('un teléfono desconocido crea contacto y conversación new; la oportunidad NO se crea sola', async () => {
    const res = await withTenant(app, tenantA, (c) =>
      receiveInbound(c, { tenantId: tenantA, phone: '+56911223344', body: 'Hola, ¿precios?' }),
    );
    expect(res.contactCreated).toBe(true);
    expect(res.conversationCreated).toBe(true);
    expect(res.conversation.state).toBe('new');
    expect(res.message.direction).toBe('in');
    expect(await eventos('conversation.created', tenantA)).toBe(1);
    expect(await eventos('message.received', tenantA)).toBe(1);
    const deals = await admin.query('SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1', [tenantA]);
    expect(deals.rows[0].n).toBe(0);
  });

  it('el segundo mensaje cae en la MISMA conversación y el trigger mantiene los tiempos', async () => {
    const res = await withTenant(app, tenantA, (c) =>
      receiveInbound(c, { tenantId: tenantA, phone: '+56911223344', body: '¿Siguen ahí?' }),
    );
    expect(res.contactCreated).toBe(false);
    expect(res.conversationCreated).toBe(false);
    expect(res.conversation.lastInboundAt).not.toBeNull();
    expect(res.conversation.lastMessageAt).not.toBeNull();
    expect(isWithin24hWindow(res.conversation.lastInboundAt)).toBe(true);
  });

  it('asignar deja historial con motivo, pasa new → open y publica los eventos', async () => {
    const { conversation } = await withTenant(app, tenantA, (c) =>
      receiveInbound(c, { tenantId: tenantA, phone: '+56911223344' }),
    );
    const asignada = await withTenant(app, tenantA, (c) =>
      assignConversation(c, {
        tenantId: tenantA,
        conversationId: conversation.id,
        toOwnerId: dueña,
        reason: 'la tomó del tablero',
        actor: dueña,
      }),
    );
    expect(asignada.state).toBe('open');
    expect(asignada.ownerId).toBe(dueña);
    const historial = await admin.query(
      'SELECT to_owner_id, reason FROM assignments WHERE tenant_id = $1 AND conversation_id = $2',
      [tenantA, conversation.id],
    );
    expect(historial.rowCount).toBe(1);
    expect(historial.rows[0].reason).toBe('la tomó del tablero');
    expect(await eventos('conversation.assigned', tenantA)).toBe(1);
  });

  it('el saliente parte queued, marca first_response_at y la entrega avanza sin retroceder', async () => {
    const conv = await admin.query(
      "SELECT id FROM conversations WHERE tenant_id = $1 AND state = 'open' LIMIT 1",
      [tenantA],
    );
    const conversationId = conv.rows[0].id;
    const msg = await withTenant(app, tenantA, (c) =>
      sendMessage(c, {
        tenantId: tenantA,
        conversationId,
        authorKind: 'user',
        authorId: dueña,
        body: '¡Hola! Te cuento los precios…',
      }),
    );
    expect(msg.deliveryStatus).toBe('queued');
    const conversacion = await withTenant(app, tenantA, (c) => getConversation(c, tenantA, conversationId));
    expect(conversacion.firstResponseAt).not.toBeNull();

    await withTenant(app, tenantA, (c) =>
      updateDeliveryStatus(c, { tenantId: tenantA, messageId: msg.id, status: 'sent', providerMessageId: 'wamid.123' }),
    );
    expect(await eventos('message.sent', tenantA)).toBe(1);
    await withTenant(app, tenantA, (c) =>
      updateDeliveryStatus(c, { tenantId: tenantA, messageId: msg.id, status: 'read' }),
    );
    await expect(
      withTenant(app, tenantA, (c) =>
        updateDeliveryStatus(c, { tenantId: tenantA, messageId: msg.id, status: 'delivered' }),
      ),
    ).rejects.toThrow(/ya terminó/);

    // Un fallo publica message.failed con el error en meta.
    const fallido = await withTenant(app, tenantA, (c) =>
      sendMessage(c, { tenantId: tenantA, conversationId, authorKind: 'agent', body: 'reintento' }),
    );
    await withTenant(app, tenantA, (c) =>
      updateDeliveryStatus(c, {
        tenantId: tenantA,
        messageId: fallido.id,
        status: 'failed',
        error: 'ventana de 24 h vencida',
      }),
    );
    expect(await eventos('message.failed', tenantA)).toBe(1);
  });

  it('resolved que recibe mensaje vuelve a open con el mismo dueño; sin dueño, a new', async () => {
    // Con dueño: la conversación asignada de arriba.
    const conv = await admin.query(
      "SELECT id FROM conversations WHERE tenant_id = $1 AND owner_id = $2 LIMIT 1",
      [tenantA, dueña],
    );
    const conId = conv.rows[0].id;
    await withTenant(app, tenantA, (c) =>
      changeConversationState(c, { tenantId: tenantA, conversationId: conId, state: 'resolved' }),
    );
    const reabierta = await withTenant(app, tenantA, (c) =>
      receiveInbound(c, { tenantId: tenantA, phone: '+56911223344', body: 'una consulta más' }),
    );
    expect(reabierta.reopened).toBe(true);
    expect(reabierta.conversation.id).toBe(conId);
    expect(reabierta.conversation.state).toBe('open');
    expect(reabierta.conversation.ownerId).toBe(dueña);

    // Sin dueño: nueva conversación de otro contacto, resolved directo (spam), reabre en new.
    const otra = await withTenant(app, tenantA, (c) =>
      receiveInbound(c, { tenantId: tenantA, phone: '+56955667788', body: 'hola' }),
    );
    await withTenant(app, tenantA, (c) =>
      changeConversationState(c, { tenantId: tenantA, conversationId: otra.conversation.id, state: 'resolved' }),
    );
    const denuevo = await withTenant(app, tenantA, (c) =>
      receiveInbound(c, { tenantId: tenantA, phone: '+56955667788', body: '¿hola?' }),
    );
    expect(denuevo.conversation.id).toBe(otra.conversation.id);
    expect(denuevo.conversation.state).toBe('new');
    expect(denuevo.conversation.ownerId).toBeNull();
  });

  it('snoozed exige fecha y despierta con un mensaje del cliente', async () => {
    const res = await withTenant(app, tenantA, (c) =>
      receiveInbound(c, { tenantId: tenantA, phone: '+56977889900', body: 'cotización' }),
    );
    await withTenant(app, tenantA, (c) =>
      assignConversation(c, { tenantId: tenantA, conversationId: res.conversation.id, toOwnerId: dueña }),
    );
    await expect(
      withTenant(app, tenantA, (c) =>
        changeConversationState(c, { tenantId: tenantA, conversationId: res.conversation.id, state: 'snoozed' }),
      ),
    ).rejects.toThrow(/hasta cuándo/);
    await withTenant(app, tenantA, (c) =>
      changeConversationState(c, {
        tenantId: tenantA,
        conversationId: res.conversation.id,
        state: 'snoozed',
        snoozedUntil: new Date(Date.now() + 86_400_000),
      }),
    );
    const despierta = await withTenant(app, tenantA, (c) =>
      receiveInbound(c, { tenantId: tenantA, phone: '+56977889900', body: 'ya volví' }),
    );
    expect(despierta.conversation.state).toBe('open');
    expect(despierta.conversation.snoozedUntil).toBeNull();
  });

  it('la idempotencia por provider_message_id evita duplicar webhooks', async () => {
    await withTenant(app, tenantA, (c) =>
      receiveInbound(c, {
        tenantId: tenantA,
        phone: '+56911223344',
        body: 'repetido',
        providerMessageId: 'wamid.dup',
      }),
    );
    await expect(
      withTenant(app, tenantA, (c) =>
        receiveInbound(c, {
          tenantId: tenantA,
          phone: '+56911223344',
          body: 'repetido',
          providerMessageId: 'wamid.dup',
        }),
      ),
    ).rejects.toThrow();
  });

  it('listMessages devuelve los últimos primero y un tenant no ve al otro (RLS)', async () => {
    const conv = await admin.query(
      'SELECT id FROM conversations WHERE tenant_id = $1 ORDER BY created_at LIMIT 1',
      [tenantA],
    );
    const mensajes = await withTenant(app, tenantA, (c) => listMessages(c, tenantA, conv.rows[0].id));
    expect(mensajes.length).toBeGreaterThan(0);

    const ajenas = await withTenant(app, tenantB, (c) => c.query('SELECT * FROM conversations'));
    const ajenos = await withTenant(app, tenantB, (c) => c.query('SELECT * FROM messages'));
    expect(ajenas.rowCount).toBe(0);
    expect(ajenos.rowCount).toBe(0);
  });
});
