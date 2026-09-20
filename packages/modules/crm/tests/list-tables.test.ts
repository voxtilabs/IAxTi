import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createContact, listContacts } from '../application/contacts';
import { createDeal, createPipeline } from '../application/deals';
import { listDeals } from '../application/board';
import { addTagToContacts, createTag } from '../application/tags';
import { InvalidListQuery } from '../application/list-cursor';

const url = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let admin: Pool;
let app: Pool;
let tenant: string;
let other: string;
let pipeline: string;
let tag: string;
const contacts: string[] = [];
beforeAll(async () => {
  admin = createPool(url); await runMigrations(admin);
  await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN CREATE ROLE iaxti_app LOGIN PASSWORD 'iaxti_app'; END IF; END $$`);
  await admin.query('GRANT USAGE ON SCHEMA public TO iaxti_app');
  await admin.query('GRANT SELECT, INSERT, UPDATE ON contacts, pipelines, stages, deals, tags, contact_tags, deal_stage_history TO iaxti_app');
  await admin.query('GRANT SELECT, INSERT ON outbox, audit_log TO iaxti_app');
  await admin.query('GRANT USAGE ON SEQUENCE audit_log_id_seq TO iaxti_app');
  app = createPool(url.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));
  tenant = (await admin.query("INSERT INTO tenants(name) VALUES ('tablas-299') RETURNING id")).rows[0].id;
  other = (await admin.query("INSERT INTO tenants(name) VALUES ('tablas-299-otro') RETURNING id")).rows[0].id;
  pipeline = (await withTenant(app, tenant, (c) => createPipeline(c, { tenantId: tenant, name: 'Ventas', stages: [{ name: 'Nuevo', type: 'open' }, { name: 'Ganado', type: 'won' }, { name: 'Perdido', type: 'lost' }] }))).pipeline.id;
  for (const [i, name] of ['Beta', 'Alfa', 'Beta', undefined, 'Zulu', 'Alfa'].entries()) {
    const contact = await withTenant(app, tenant, (c) => createContact(c, { tenantId: tenant, phone: `+5697101000${i}`, name }));
    contacts.push(contact.id);
    const deal = await withTenant(app, tenant, (c) => createDeal(c, { tenantId: tenant, contactId: contact.id, pipelineId: pipeline, title: name ?? 'Sin título de prueba', value: i % 2 ? 200 : 100 }));
    await admin.query('UPDATE contacts SET last_activity_at = $2::timestamptz WHERE id = $1', [contact.id, `2026-01-01T00:00:00.00000${i + 1}Z`]);
    await admin.query('UPDATE deals SET created_at = $2::timestamptz, value_clp = $3 WHERE id = $1', [deal.id, `2026-01-01T00:00:00.00000${i + 1}Z`, i === 3 ? null : i % 2 ? 200 : 100]);
  }
  tag = (await withTenant(app, tenant, (c) => createTag(c, { tenantId: tenant, name: 'Revisar' }))).id;
});
afterAll(async () => { await app?.end(); await admin?.end(); }); // La auditoría es append-only; se conserva la evidencia sintética.

describe('tablas con cursor y PostgreSQL real', () => {
  for (const order of ['asc', 'desc']) {
    for (const [sort, column] of [['name', 'name'], ['phone', 'phone'], ['activity', 'last_activity_at']]) {
      it(`contactos por ${sort} ${order}: empates, nulos y microsegundos sin pérdidas ni duplicados`, async () => {
        const found: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await withTenant(app, tenant, (c) => listContacts(c, tenant, { sort, order, cursor, limit: 2 }));
          found.push(...page.items.map((i) => i.id)); cursor = page.nextCursor ?? undefined;
        } while (cursor && found.length < 20);
        const expected = await admin.query(`SELECT id FROM contacts WHERE tenant_id = $1 ORDER BY ${column} ${order} NULLS LAST, id ${order}`, [tenant]);
        expect(found).toEqual(expected.rows.map((r) => r.id));
      });
    }
    for (const [sort, column] of [['title', 'title'], ['value', 'value_clp'], ['created', 'created_at']]) {
      it(`oportunidades por ${sort} ${order}: página y orden se aplican en SQL`, async () => {
        const found: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await withTenant(app, tenant, (c) => listDeals(c, tenant, { pipelineId: pipeline, sort, order, cursor, limit: 2 }));
          found.push(...page.items.map((i) => i.id)); cursor = page.nextCursor ?? undefined;
        } while (cursor && found.length < 20);
        const expected = await admin.query(`SELECT id FROM deals WHERE tenant_id = $1 ORDER BY ${column} ${order} NULLS LAST, id ${order}`, [tenant]);
        expect(found).toEqual(expected.rows.map((r) => r.id));
      });
    }
  }
  it('rechaza cursores de otro filtro/orden/tenant y argumentos inválidos', async () => {
    const page = await withTenant(app, tenant, (c) => listContacts(c, tenant, { limit: 1 }));
    const decoded = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString());
    for (const v of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '1', 'texto\0invalido']) {
      const cursor = Buffer.from(JSON.stringify({ ...decoded, v })).toString('base64url');
      await expect(withTenant(app, tenant, (c) => listContacts(c, tenant, { cursor }))).rejects.toBeInstanceOf(InvalidListQuery);
    }
    for (const filter of [{ q: 'Alfa', cursor: page.nextCursor! }, { sort: 'name', cursor: page.nextCursor! }, { cursor: 'invalido' }, { limit: 0 }, { sort: 'name; DELETE FROM contacts' }, { order: 'invalido' }]) {
      await expect(withTenant(app, tenant, (c) => listContacts(c, tenant, filter))).rejects.toThrow();
    }
    await expect(withTenant(app, other, (c) => listContacts(c, other, { cursor: page.nextCursor! }))).rejects.toThrow();
    expect((await withTenant(app, other, (c) => listContacts(c, tenant))).items).toEqual([]);
    const filtered = await withTenant(app, tenant, (c) => listContacts(c, tenant, { q: 'Alfa', sort: 'name', order: 'asc' }));
    expect(filtered.items).toHaveLength(2);
  });

  it('etiquetar agrega sin quitar, es idempotente y audita en la misma transacción', async () => {
    const original = await withTenant(app, tenant, (c) => createTag(c, { tenantId: tenant, name: 'Original' }));
    await admin.query('INSERT INTO contact_tags(tenant_id, contact_id, tag_id) VALUES ($1,$2,$3)', [tenant, contacts[0], original.id]);
    const input = { tenantId: tenant, contactIds: contacts.slice(0, 2), tagId: tag, actor: randomUUID() };
    await expect(withTenant(app, tenant, async (c) => { await addTagToContacts(c, input); throw new Error('rollback de prueba'); })).rejects.toThrow('rollback');
    expect((await admin.query('SELECT * FROM contact_tags WHERE tenant_id=$1 AND tag_id=$2', [tenant, tag])).rowCount).toBe(0);
    expect((await admin.query("SELECT * FROM audit_log WHERE tenant_id=$1 AND action='contacts.tag_added'", [tenant])).rowCount).toBe(0);
    expect(await withTenant(app, tenant, (c) => addTagToContacts(c, input))).toEqual({ requested: 2, changed: 2 });
    expect(await withTenant(app, tenant, (c) => addTagToContacts(c, input))).toEqual({ requested: 2, changed: 0 });
    expect((await admin.query('SELECT * FROM contact_tags WHERE tenant_id=$1 AND contact_id=$2', [tenant, contacts[0]])).rowCount).toBe(2);
    expect((await admin.query("SELECT * FROM audit_log WHERE tenant_id=$1 AND action='contacts.tag_added'", [tenant])).rowCount).toBe(1);
    const foreign = await withTenant(app, other, (c) => createContact(c, { tenantId: other, phone: '+56979999999' }));
    await expect(withTenant(app, tenant, (c) => addTagToContacts(c, { ...input, contactIds: [contacts[2], foreign.id] }))).rejects.toThrow('negocio');
    expect((await admin.query('SELECT * FROM contact_tags WHERE tenant_id=$1 AND contact_id=$2', [tenant, contacts[2]])).rowCount).toBe(0);
  });
});
