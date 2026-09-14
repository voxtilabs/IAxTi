import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { ensureContactByIdentity } from '../application/contacts';
import { exportarTitular, suprimirTitular } from '../application/titular';

// Derechos del titular (#81, Ley 21.719): acceso/portabilidad y supresión.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let contactId: string;
let conversationId: string;
const duena = randomUUID();

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('titular-test') RETURNING id");
  tenant = t.rows[0].id;

  const { contact } = await withTenant(admin, tenant, (c) =>
    ensureContactByIdentity(c, {
      tenantId: tenant,
      channel: 'whatsapp',
      identity: '+56987651234',
      origin: 'whatsapp',
    }),
  );
  contactId = contact.id;
  await admin.query(
    `UPDATE contacts SET name = 'María Paz', email = 'maria@test.cl', rut = '11111111-1',
            custom = '{"talla":"M"}'::jsonb, opt_in_evidence = 'escribió primero'
      WHERE id = $1`,
    [contactId],
  );
  const conv = await admin.query(
    `INSERT INTO conversations (tenant_id, contact_id, channel) VALUES ($1, $2, 'whatsapp') RETURNING id`,
    [tenant, contactId],
  );
  conversationId = conv.rows[0].id;
  await admin.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, type, body, author_kind, attachments)
     VALUES ($1, $2, 'in', 'texto', 'Hola, quiero cotizar', 'contact', '[{"key":"t/whatsapp/boleta.jpg"}]'::jsonb),
            ($1, $2, 'out', 'texto', 'Te paso el detalle', 'user', '[]'::jsonb)`,
    [tenant, conversationId],
  );
});

afterAll(async () => {
  await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete');
  await admin.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]);
  await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete');
  for (const tabla of ['messages', 'conversations', 'contact_identities', 'contacts']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('derecho de acceso y portabilidad (#81)', () => {
  it('entrega todo lo que tenemos de la persona, mensajes incluidos', async () => {
    const doc = await withTenant(admin, tenant, (c) =>
      exportarTitular(c, { tenantId: tenant, contactId, actor: duena }),
    );
    expect(doc.contacto.name).toBe('María Paz');
    expect(doc.identidades).toHaveLength(1);
    expect(doc.conversaciones).toHaveLength(1);
    // El contenido de sus mensajes también es suyo.
    expect(doc.mensajes).toHaveLength(2);
    expect(doc.mensajes[0].body).toBe('Hola, quiero cotizar');

    // El ejercicio del derecho queda auditado.
    const rastro = await admin.query(
      `SELECT action FROM audit_log WHERE tenant_id = $1 AND resource_id = $2`,
      [tenant, contactId],
    );
    expect(rastro.rows.map((r) => r.action)).toContain('titular.exportado');
  });

  it('una persona que no es de este negocio no se exporta', async () => {
    await expect(
      withTenant(admin, tenant, (c) =>
        exportarTitular(c, { tenantId: tenant, contactId: randomUUID(), actor: duena }),
      ),
    ).rejects.toThrow(/No encontramos/);
  });
});

describe('derecho de supresión (#81)', () => {
  it('exige el motivo: es parte de la evidencia', async () => {
    await expect(
      withTenant(admin, tenant, (c) =>
        suprimirTitular(c, { tenantId: tenant, contactId, actor: duena, motivo: '  ' }),
      ),
    ).rejects.toThrow(/motivo/);
  });

  it('borra a la persona y su contenido, pero conserva el rastro del trato', async () => {
    const res = await withTenant(admin, tenant, (c) =>
      suprimirTitular(c, {
        tenantId: tenant,
        contactId,
        actor: duena,
        motivo: 'La clienta pidió que borráramos sus datos',
      }),
    );
    expect(res.mensajesBorrados).toBe(2);
    expect(res.identidadesBorradas).toBe(1);
    // Los adjuntos se devuelven para borrarlos de R2 DESPUÉS del commit.
    expect(res.adjuntosR2).toEqual(['t/whatsapp/boleta.jpg']);

    const contacto = await admin.query('SELECT * FROM contacts WHERE id = $1', [contactId]);
    const fila = contacto.rows[0];
    // La fila sigue: la oportunidad y la factura cuelgan de ella.
    expect(fila).toBeDefined();
    // La persona, no: nada que la identifique queda en pie.
    expect(fila.name).toBeNull();
    expect(fila.phone).toBeNull();
    expect(fila.email).toBeNull();
    expect(fila.rut).toBeNull();
    expect(fila.custom).toEqual({});
    expect(fila.opt_in_evidence).toBeNull();
    // Y queda como opt-out: no se le vuelve a escribir.
    expect(fila.opted_out_at).not.toBeNull();

    const mensajes = await admin.query(
      'SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1',
      [conversationId],
    );
    expect(mensajes.rows[0].n).toBe(0);

    const conv = await admin.query('SELECT archived_at, summary FROM conversations WHERE id = $1', [
      conversationId,
    ]);
    expect(conv.rows[0].archived_at).not.toBeNull();
    expect(conv.rows[0].summary).toBeNull();

    // El libro de auditoría NO se toca: es la prueba de que esto ocurrió.
    const rastro = await admin.query(
      `SELECT action, metadata FROM audit_log
        WHERE tenant_id = $1 AND resource_id = $2 AND action = 'titular.suprimido'`,
      [tenant, contactId],
    );
    expect(rastro.rowCount).toBe(1);
    expect(rastro.rows[0].metadata.motivo).toMatch(/pidió que borráramos/);
  });
});
