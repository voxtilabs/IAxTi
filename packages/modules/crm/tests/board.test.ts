import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  deleteSavedFilter,
  listDeals,
  listPipelines,
  listSavedFilters,
  saveFilter,
} from '../application/board';
import { createContact } from '../application/contacts';
import { createDeal, createPipeline } from '../application/deals';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenant: string;
let pipelineId: string;
const vendedora = randomUUID();

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
    'GRANT SELECT, INSERT, UPDATE ON contacts, contact_identities, pipelines, stages, deals, loss_reasons, deal_stage_history, tags, contact_tags TO iaxti_app',
  );
  await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON saved_filters TO iaxti_app');
  await admin.query('GRANT INSERT ON outbox TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('board-test') RETURNING id");
  tenant = t.rows[0].id;

  const pipe = await withTenant(app, tenant, (c) =>
    createPipeline(c, {
      tenantId: tenant,
      name: 'Ventas',
      stages: [
        { name: 'Nuevo', type: 'open' },
        { name: 'Cotizado', type: 'open' },
        { name: 'Ganado', type: 'won' },
        { name: 'Perdido', type: 'lost' },
      ],
    }),
  );
  pipelineId = pipe.pipeline.id;

  // Tres oportunidades: dos de la vendedora (una con etiqueta VIP y custom),
  // una sin dueño.
  for (const [i, dueño] of [vendedora, vendedora, null].entries()) {
    const contacto = await withTenant(app, tenant, (c) =>
      createContact(c, { tenantId: tenant, phone: `+5697100000${i}`, name: `Cliente ${i}` }),
    );
    const deal = await withTenant(app, tenant, (c) =>
      createDeal(c, {
        tenantId: tenant,
        contactId: contacto.id,
        pipelineId,
        title: `Negocio ${i}`,
        value: (i + 1) * 100_000,
        ownerId: dueño ?? undefined,
      }),
    );
    if (i === 0) {
      await admin.query(`UPDATE deals SET custom = '{"comuna":"Ñuñoa"}'::jsonb WHERE id = $1`, [deal.id]);
      const tag = await admin.query(
        `INSERT INTO tags (tenant_id, name, role) VALUES ($1, 'VIP', 'good') RETURNING id`,
        [tenant],
      );
      await admin.query(
        'INSERT INTO contact_tags (tenant_id, contact_id, tag_id) VALUES ($1, $2, $3)',
        [tenant, contacto.id, tag.rows[0].id],
      );
    }
  }
});

afterAll(async () => {
  await app.end();
  for (const tabla of ['saved_filters', 'contact_tags', 'tags', 'deal_stage_history', 'deals', 'stages', 'pipelines', 'loss_reasons', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('tablero y lista (rol de aplicación, #33)', () => {
  it('listPipelines trae las etapas ordenadas', async () => {
    const pipes = await withTenant(app, tenant, (c) => listPipelines(c, tenant));
    expect(pipes).toHaveLength(1);
    expect(pipes[0].stages.map((s) => s.name)).toEqual(['Nuevo', 'Cotizado', 'Ganado', 'Perdido']);
  });

  it('filtra por valor, etiqueta del contacto y campo custom', async () => {
    const caras = await withTenant(app, tenant, (c) =>
      listDeals(c, tenant, { pipelineId, valueClpMin: 250_000 }),
    );
    expect(caras.items.map((d) => d.title)).toEqual(['Negocio 2']);

    const vip = await withTenant(app, tenant, (c) => listDeals(c, tenant, { tag: 'VIP' }));
    expect(vip.items.map((d) => d.title)).toEqual(['Negocio 0']);

    const comuna = await withTenant(app, tenant, (c) =>
      listDeals(c, tenant, { custom: { key: 'comuna', value: 'Ñuñoa' } }),
    );
    expect(comuna.items.map((d) => d.title)).toEqual(['Negocio 0']);
  });

  it('sin crm.read_all se ven las propias y las sin dueño; el cursor pagina', async () => {
    const otra = randomUUID();
    const visibles = await withTenant(app, tenant, (c) =>
      listDeals(c, tenant, { ownerIdOrUnassigned: otra }),
    );
    expect(visibles.items.map((d) => d.title)).toEqual(['Negocio 2']); // solo la sin dueño

    const p1 = await withTenant(app, tenant, (c) => listDeals(c, tenant, { limit: 2 }));
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await withTenant(app, tenant, (c) =>
      listDeals(c, tenant, { limit: 2, cursor: p1.nextCursor! }),
    );
    expect(p2.items).toHaveLength(1);
    const ids = new Set([...p1.items, ...p2.items].map((d) => d.id));
    expect(ids.size).toBe(3);
  });

  it('los filtros guardados son por usuario: guardar, actualizar, borrar', async () => {
    await withTenant(app, tenant, (c) =>
      saveFilter(c, { tenantId: tenant, userId: vendedora, name: 'Caras', filters: { valueClpMin: '250000' } }),
    );
    await withTenant(app, tenant, (c) =>
      saveFilter(c, { tenantId: tenant, userId: vendedora, name: 'Caras', filters: { valueClpMin: '300000' } }),
    );
    const mios = await withTenant(app, tenant, (c) => listSavedFilters(c, tenant, vendedora));
    expect(mios).toHaveLength(1);
    expect(mios[0].filters).toEqual({ valueClpMin: '300000' }); // upsert por nombre

    const deOtra = await withTenant(app, tenant, (c) => listSavedFilters(c, tenant, randomUUID()));
    expect(deOtra).toEqual([]);

    await expect(
      withTenant(app, tenant, (c) =>
        deleteSavedFilter(c, { tenantId: tenant, userId: randomUUID(), id: mios[0].id }),
      ),
    ).rejects.toThrow(/no es tuyo/);
    await withTenant(app, tenant, (c) =>
      deleteSavedFilter(c, { tenantId: tenant, userId: vendedora, id: mios[0].id }),
    );
  });
});
