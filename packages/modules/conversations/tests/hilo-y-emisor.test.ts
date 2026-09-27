import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { getOutboundContext, receiveInbound, sendMessage } from '../application/conversations';

// Dos cosas que se veían igual de mal desde el celular del cliente:
//
// 1. La pyme con dos números (ventas y soporte). El hilo quedaba amarrado al
//    emisor que lo CREÓ, así que el cliente escribía a soporte y le contestaba
//    ventas. Un número al que nunca escribió.
// 2. La identidad entrante se parseaba como teléfono chileno. Lo que no calzaba
//    reventaba con el mensaje crudo del sistema DESPUÉS del 200 del webhook: el
//    mensaje no llegaba a la bandeja y nadie se enteraba.

const URL_BASE = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

/** Lo que el camino de entrada escribe: si algo falla, nada de esto se mueve. */
async function conteos(): Promise<{ contactos: number; conversaciones: number; mensajes: number }> {
  const r = await admin.query(
    `SELECT (SELECT count(*)::int FROM contacts WHERE tenant_id = $1)      AS contactos,
            (SELECT count(*)::int FROM conversations WHERE tenant_id = $1) AS conversaciones,
            (SELECT count(*)::int FROM messages WHERE tenant_id = $1)      AS mensajes`,
    [tenant],
  );
  return r.rows[0];
}

beforeAll(async () => {
  admin = createPool(URL_BASE);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('hilo-y-emisor') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  // El tenant se queda: audit_log lo referencia y es append-only por trigger,
  // así que no hay forma (ni ganas) de borrar su rastro.
  for (const tabla of ['messages', 'conversations', 'contact_identities', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('el hilo se muda al emisor por el que entró el mensaje', () => {
  it('el cliente escribe a soporte y la respuesta sale por soporte, no por ventas', async () => {
    const ventas = randomUUID();
    const soporte = randomUUID();
    const phone = '+56911223399';

    const primero = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone,
        channel: 'whatsapp',
        channelAccountId: ventas,
        body: 'Quiero cotizar',
        providerMessageId: 'hilo-ventas-1',
        requestId: 'req-ventas',
      }),
    );
    expect(primero.conversationCreated).toBe(true);

    const segundo = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone,
        channel: 'whatsapp',
        channelAccountId: soporte,
        body: 'Se me cayó el servicio',
        providerMessageId: 'hilo-soporte-1',
        requestId: 'req-soporte',
      }),
    );
    // El hilo NO se parte: misma historia, mismo dueño, misma ventana de 24 h.
    expect(segundo.conversationCreated).toBe(false);
    expect(segundo.conversation.id).toBe(primero.conversation.id);

    const fila = await admin.query('SELECT channel_account_id FROM conversations WHERE id = $1', [
      primero.conversation.id,
    ]);
    expect(fila.rows[0].channel_account_id).toBe(soporte);

    // Lo que de verdad ve el cliente: por dónde le sale la respuesta.
    const saliente = await withTenant(admin, tenant, (c) =>
      sendMessage(c, {
        tenantId: tenant,
        conversationId: primero.conversation.id,
        authorKind: 'user',
        authorId: randomUUID(),
        body: 'Lo vemos al tiro',
      }),
    );
    const ctx = await withTenant(admin, tenant, (c) => getOutboundContext(c, tenant, saliente.id));
    expect(ctx?.channelAccountId).toBe(soporte);

    // Cambia por dónde le hablamos al cliente: queda auditado.
    const audit = await admin.query(
      `SELECT resource, resource_id, request_id, metadata FROM audit_log
        WHERE tenant_id = $1 AND action = 'conversation.sender_changed'`,
      [tenant],
    );
    expect(audit.rows).toEqual([
      {
        resource: 'conversation',
        resource_id: primero.conversation.id,
        request_id: 'req-soporte',
        metadata: { channel: 'whatsapp', from: ventas, to: soporte },
      },
    ]);
  });

  it('si el canal no dice por qué cuenta entró, se deja la que había y no se audita nada', async () => {
    const ventas = randomUUID();
    const phone = '+56911223398';

    const primero = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone,
        channel: 'whatsapp',
        channelAccountId: ventas,
        body: 'Hola',
        providerMessageId: 'sin-cuenta-1',
      }),
    );
    await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone,
        channel: 'whatsapp',
        body: '¿Siguen ahí?',
        providerMessageId: 'sin-cuenta-2',
      }),
    );

    const fila = await admin.query('SELECT channel_account_id FROM conversations WHERE id = $1', [
      primero.conversation.id,
    ]);
    // Borrarla dejaría el hilo sin por dónde responder.
    expect(fila.rows[0].channel_account_id).toBe(ventas);
    const audit = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE tenant_id = $1 AND action = 'conversation.sender_changed'
          AND resource_id = $2`,
      [tenant, primero.conversation.id],
    );
    expect(audit.rows[0].n).toBe(0);
  });
});

describe('la identidad que no se puede resolver no desaparece en silencio', () => {
  it('una identidad que no es teléfono falla con el formato único y sin el mensaje crudo', async () => {
    const antes = await conteos();
    const identidad = 'ig_17841400000009';
    const err = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: identidad,
        channel: 'whatsapp',
        body: 'Hola, ¿precios?',
        providerMessageId: 'identidad-rara-1',
        requestId: 'req-identidad-rara',
      }),
    ).then(
      () => null,
      (e: Error & { code?: string; requestId?: string; details?: unknown[] }) => e,
    );

    expect(err).not.toBeNull();
    expect(err?.code).toBe('INBOUND_IDENTIDAD_NO_RESUELTA');
    expect(err?.requestId).toBe('req-identidad-rara');
    // Qué pasó y qué hacer, sin el mensaje crudo del sistema.
    expect(err?.message).toMatch(/no entró a la bandeja/);
    expect(err?.message).toMatch(/reintenta el job/);
    expect(err?.message).not.toMatch(/Teléfono inválido/);
    // La identidad es PII: en details va enmascarada, nunca completa.
    const detalle = (err?.details ?? [])[0] as { campo: string; canal: string; identidad: string };
    expect(detalle.campo).toBe('phone');
    expect(detalle.canal).toBe('whatsapp');
    expect(detalle.identidad).toMatch(/^\*+0009$/);
    expect(detalle.identidad).not.toContain('ig_');
    // Y no quedó nada a medias.
    expect(await conteos()).toEqual(antes);
  });

  it('un mensaje sin identidad se rechaza en vez de crear un contacto en blanco', async () => {
    const antes = await conteos();
    const err = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, {
        tenantId: tenant,
        phone: '   ',
        channel: 'instagram',
        body: 'Hola',
        providerMessageId: 'sin-identidad-1',
        requestId: 'req-sin-identidad',
      }),
    ).then(
      () => null,
      (e: Error & { code?: string; details?: unknown[] }) => e,
    );

    expect(err?.code).toBe('INBOUND_IDENTIDAD_NO_RESUELTA');
    expect(err?.details).toEqual([{ campo: 'phone', canal: 'instagram', identidad: null }]);
    expect(await conteos()).toEqual(antes);
  });
});
