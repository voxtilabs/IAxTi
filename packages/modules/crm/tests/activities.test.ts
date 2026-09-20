import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  completeActivity,
  createActivity,
  getContactFicha,
  listActivitiesByContact,
  markDueActivities,
} from '../application/activities';
import { createContact } from '../application/contacts';
import { createDeal, createPipeline } from '../application/deals';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenant: string;
let contacto: string;

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
    'GRANT SELECT, INSERT, UPDATE ON contacts, contact_identities, pipelines, stages, deals, loss_reasons, deal_stage_history, activities TO iaxti_app',
  );
  await admin.query('GRANT INSERT ON outbox TO iaxti_app');
  await admin.query('GRANT SELECT, INSERT ON audit_log TO iaxti_app');
  await admin.query('GRANT USAGE ON SEQUENCE audit_log_id_seq TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('activities-test') RETURNING id");
  tenant = t.rows[0].id;
  const c = await withTenant(app, tenant, (cl) =>
    createContact(cl, { tenantId: tenant, phone: '+56970000001', name: 'Doña Carmen', rut: '11.111.111-1' }),
  );
  contacto = c.id;
  const pipe = await withTenant(app, tenant, (cl) =>
    createPipeline(cl, {
      tenantId: tenant,
      name: 'Ventas',
      stages: [
        { name: 'Nuevo', type: 'open' },
        { name: 'Ganado', type: 'won' },
        { name: 'Perdido', type: 'lost' },
      ],
    }),
  );
  await withTenant(app, tenant, (cl) =>
    createDeal(cl, {
      tenantId: tenant,
      contactId: contacto,
      pipelineId: pipe.pipeline.id,
      title: 'Plan familiar',
      value: 890_000,
    }),
  );
});

afterAll(async () => {
  await app.end();
  for (const tabla of ['activities', 'deal_stage_history', 'deals', 'stages', 'pipelines', 'loss_reasons', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  // El tenant se conserva: audit_log es append-only incluso en los tests.
  await admin.end();
});

describe('actividades (rol de aplicación, #32)', () => {
  it('un rollback revierte actividad, última actividad y auditoría juntos (#346)', async () => {
    const antes = await admin.query('SELECT last_activity_at FROM contacts WHERE id = $1', [contacto]);
    let actividadId: string | undefined;
    await expect(withTenant(app, tenant, async (c) => {
      const actividad = await createActivity(c, {
        tenantId: tenant, contactId: contacto, type: 'nota', title: 'Se revierte',
        actor: 'apikey:test', actorKind: 'apikey',
      });
      actividadId = actividad.id;
      throw new Error('rollback deliberado');
    })).rejects.toThrow('rollback deliberado');
    expect((await admin.query('SELECT 1 FROM activities WHERE id = $1', [actividadId])).rowCount).toBe(0);
    expect((await admin.query('SELECT 1 FROM audit_log WHERE resource_id = $1', [actividadId])).rowCount).toBe(0);
    expect((await admin.query('SELECT last_activity_at FROM contacts WHERE id = $1', [contacto])).rows).toEqual(antes.rows);
  });

  it('crear toca last_activity_at del contacto y exige título', async () => {
    const antes = await admin.query('SELECT last_activity_at FROM contacts WHERE id = $1', [contacto]);
    await new Promise((r) => setTimeout(r, 10));
    await withTenant(app, tenant, (c) =>
      createActivity(c, { tenantId: tenant, contactId: contacto, type: 'llamada', title: 'Llamarla por el plan' }),
    );
    const despues = await admin.query('SELECT last_activity_at FROM contacts WHERE id = $1', [contacto]);
    expect(new Date(despues.rows[0].last_activity_at).getTime())
      .toBeGreaterThan(new Date(antes.rows[0].last_activity_at).getTime());
    await expect(
      withTenant(app, tenant, (c) =>
        createActivity(c, { tenantId: tenant, contactId: contacto, type: 'tarea', title: '  ' }),
      ),
    ).rejects.toThrow(/título/);
  });

  it('la vencida publica activity.due UNA vez; completarla la saca del radar', async () => {
    const vencida = await withTenant(app, tenant, (c) =>
      createActivity(c, {
        tenantId: tenant,
        contactId: contacto,
        type: 'tarea',
        title: 'Mandar cotización',
        dueAt: new Date(Date.now() - 3_600_000),
      }),
    );
    const marcadas = await withTenant(app, tenant, (c) => markDueActivities(c, tenant));
    expect(marcadas).toContain(vencida.id);
    const eventos = await admin.query(
      "SELECT count(*)::int AS n FROM outbox WHERE name = 'activity.due' AND tenant_id = $1",
      [tenant],
    );
    expect(eventos.rows[0].n).toBe(1);
    expect(await withTenant(app, tenant, (c) => markDueActivities(c, tenant))).toEqual([]);

    const hecha = await withTenant(app, tenant, (c) =>
      completeActivity(c, { tenantId: tenant, activityId: vencida.id }),
    );
    expect(hecha.doneAt).not.toBeNull();
  });

  it('el listado pone primero lo pendiente por vencimiento', async () => {
    const lista = await withTenant(app, tenant, (c) => listActivitiesByContact(c, tenant, contacto));
    expect(lista.length).toBeGreaterThanOrEqual(2);
    expect(lista[0].doneAt).toBeNull(); // pendientes antes que hechas
  });

  it('la ficha une contacto, oportunidades (con etapa) y actividades', async () => {
    const ficha = await withTenant(app, tenant, (c) => getContactFicha(c, tenant, contacto));
    expect(ficha.contact.name).toBe('Doña Carmen');
    expect(ficha.contact.rut).toBe('11111111-1');
    expect(ficha.deals).toHaveLength(1);
    expect(ficha.deals[0].stage_name).toBe('Nuevo');
    expect(ficha.deals[0].pipeline_name).toBe('Ventas');
    expect(Number(ficha.deals[0].value_clp)).toBe(890_000);
    expect(ficha.activities.length).toBeGreaterThanOrEqual(2);
    await expect(
      withTenant(app, tenant, (c) => getContactFicha(c, tenant, '00000000-0000-0000-0000-000000000000')),
    ).rejects.toThrow(/No encontramos/);
  });
});
