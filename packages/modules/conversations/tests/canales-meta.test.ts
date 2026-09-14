import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { identityFor } from '@iaxti/module-crm';
import { getOutboundContext, receiveInbound } from '../application/conversations';
import { isWithinWindow } from '../domain/state';

// Instagram y Messenger en la MISMA bandeja (#74): quien escribe por ahí no
// trae teléfono, solo un id de chat. El contacto existe igual y se le responde
// por donde escribió.

const URL_BASE = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

beforeAll(async () => {
  admin = createPool(URL_BASE);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('canales-meta') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  for (const tabla of ['messages', 'conversations', 'contact_identities', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('Instagram y Messenger en la bandeja (#74)', () => {
  it('un DM de Instagram crea el contacto sin teléfono y no lo duplica', async () => {
    const primero = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: '17841400000001', // id de chat de Instagram, no un teléfono
        channel: 'instagram',
        body: 'Hola, ¿venden al por mayor?',
        providerMessageId: 'ig-1',
      }),
    );
    expect(primero.contactCreated).toBe(true);
    expect(primero.contact.phone).toBeNull();
    expect(primero.contact.origin).toBe('instagram');
    expect(primero.conversation.channel).toBe('instagram');

    const segundo = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: '17841400000001',
        channel: 'instagram',
        body: '¿Hola?',
        providerMessageId: 'ig-2',
      }),
    );
    expect(segundo.contactCreated).toBe(false);
    expect(segundo.contact.id).toBe(primero.contact.id);
    expect(segundo.conversationCreated).toBe(false);
  });

  it('el mismo id en otro canal es otra persona, y el teléfono sigue siendo de WhatsApp', async () => {
    const messenger = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: '17841400000001', // mismo número de id, canal distinto
        channel: 'messenger',
        body: 'Hola desde Messenger',
        providerMessageId: 'ms-1',
      }),
    );
    expect(messenger.contactCreated).toBe(true);
    expect(messenger.contact.origin).toBe('messenger');

    const wsp = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: '+56987650001',
        channel: 'whatsapp',
        body: 'Hola por WhatsApp',
        providerMessageId: 'wa-1',
      }),
    );
    expect(wsp.contact.phone).toBe('+56987650001');
    // El teléfono quedó también como identidad explícita del canal WhatsApp.
    const idWsp = await withTenant(admin, tenant, (c) =>
      identityFor(c, { tenantId: tenant, contactId: wsp.contact.id, channel: 'whatsapp' }),
    );
    expect(idWsp).toBe('+56987650001');
  });

  it('se responde por donde escribió: el contexto de salida trae la identidad del canal', async () => {
    const ig = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: '17841400000009',
        channel: 'instagram',
        body: 'Consulta',
        providerMessageId: 'ig-9',
      }),
    );
    const salida = await admin.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, type, body, author_kind)
       VALUES ($1, $2, 'out', 'texto', 'Te respondo', 'user') RETURNING id`,
      [tenant, ig.conversation.id],
    );
    const ctx = await withTenant(admin, tenant, (c) =>
      getOutboundContext(c, tenant, salida.rows[0].id),
    );
    expect(ctx?.channel).toBe('instagram');
    // Sin esto le mandaríamos el mensaje a un teléfono que no existe.
    expect(ctx?.phone).toBe('17841400000009');
  });

  it('la ventana es por canal, y el webchat no tiene', () => {
    const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const hace30h = new Date(Date.now() - 30 * 60 * 60 * 1000);
    for (const canal of ['whatsapp', 'instagram', 'messenger']) {
      expect(isWithinWindow(canal, hace2h)).toBe(true);
      expect(isWithinWindow(canal, hace30h)).toBe(false);
      expect(isWithinWindow(canal, null)).toBe(false);
    }
    // El webchat es nuestro: no hay ventana que pedirle permiso a nadie.
    expect(isWithinWindow('webchat', hace30h)).toBe(true);
    expect(isWithinWindow('webchat', null)).toBe(true);
  });
});
