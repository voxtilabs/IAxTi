import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { guessMapping, parseCsv, sniffDelimiter } from '../domain/csv';
import { confirmImport, mergeContacts, previewImport } from '../application/merge';
import { createContact, ensureContactByPhone } from '../application/contacts';
import { createActivity } from '../application/activities';
import { createDeal, createPipeline } from '../application/deals';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenant: string;

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
    'GRANT SELECT, INSERT, UPDATE ON contacts, contact_identities, pipelines, stages, deals, loss_reasons, deal_stage_history, tags, contact_tags, activities TO iaxti_app',
  );
  await admin.query('GRANT SELECT, INSERT ON audit_log TO iaxti_app');
  await admin.query('GRANT INSERT ON outbox TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('merge-test') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await app.end();
  // audit_log es append-only y referencia al tenant: el tenant queda.
  for (const tabla of ['contact_tags', 'tags', 'activities', 'deal_stage_history', 'deals', 'stages', 'pipelines', 'loss_reasons', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('CSV chileno (dominio)', () => {
  it('olfatea el delimitador, respeta comillas y bota el BOM', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(sniffDelimiter('a,b\n1,2')).toBe(',');
    const rows = parseCsv('﻿nombre;fono\n"Soto; María";"+56 9 1234 5678"\n');
    expect(rows).toEqual([['nombre', 'fono'], ['Soto; María', '+56 9 1234 5678']]);
  });

  it('adivina el mapeo por encabezados típicos de Excel', () => {
    expect(guessMapping(['Nombre Cliente', 'Celular', 'RUT', 'Correo'])).toEqual({
      0: 'name',
      1: 'phone',
      2: 'rut',
      3: 'email',
    });
  });
});

describe('importación (rol de aplicación)', () => {
  const CSV = [
    'nombre;telefono;rut',
    'María Paz;9 1111 2222;11.111.111-1',
    'Malo;12345;',
    'Repetida;9 1111 2222;',
    'Pedro;9 3333 4444;',
  ].join('\n');

  it('la vista previa valida fila por fila sin escribir nada', async () => {
    const preview = await withTenant(app, tenant, (c) =>
      previewImport(c, { tenantId: tenant, csv: CSV }),
    );
    expect(preview.validas).toBe(2);
    expect(preview.rows[0].ok).toBe(true);
    expect(preview.rows[0].data).toMatchObject({ phone: '+56911112222', rut: '11111111-1' });
    expect(preview.rows[1].ok).toBe(false);
    expect(preview.rows[1].errores[0]).toMatchObject({ field: 'phone' }); // formato único
    expect(preview.rows[2].duplicadoEnArchivo).toBe(true);
    const nada = await admin.query('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [tenant]);
    expect(nada.rows[0].n).toBe(0);
  });

  it('confirmar crea SOLO lo válido, sin opt-in, y audita la corrida', async () => {
    const res = await withTenant(app, tenant, (c) =>
      confirmImport(c, { tenantId: tenant, csv: CSV, actor: 'test' }),
    );
    expect(res).toEqual({ created: 2, skipped: 2 });
    const maria = await admin.query(
      `SELECT origin, opt_in_at FROM contacts WHERE tenant_id = $1 AND phone = '+56911112222'`,
      [tenant],
    );
    expect(maria.rows[0].origin).toBe('importado');
    expect(maria.rows[0].opt_in_at).toBeNull(); // los importados nacen sin opt-in

    // La segunda corrida no duplica: ya existen.
    const otra = await withTenant(app, tenant, (c) =>
      confirmImport(c, { tenantId: tenant, csv: CSV, actor: 'test' }),
    );
    expect(otra.created).toBe(0);

    const audit = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'contacts.import.run'`,
      [tenant],
    );
    expect(audit.rows[0].n).toBe(2); // una entrada POR corrida
  });
});

describe('fusión (rol de aplicación)', () => {
  it('conserva ambas historias e identificadores, audita y no se repite', async () => {
    const principal = await withTenant(app, tenant, (c) =>
      createContact(c, { tenantId: tenant, phone: '+56955550001', name: null as unknown as string }),
    );
    const duplicado = await withTenant(app, tenant, (c) =>
      createContact(c, { tenantId: tenant, phone: '+56955550002', name: 'Carmen Duplicada', rut: '11.111.111-1' }),
    );
    const pipe = await withTenant(app, tenant, (c) =>
      createPipeline(c, {
        tenantId: tenant,
        name: 'Fusión',
        stages: [
          { name: 'Nuevo', type: 'open' },
          { name: 'Ganado', type: 'won' },
          { name: 'Perdido', type: 'lost' },
        ],
      }),
    );
    await withTenant(app, tenant, (c) =>
      createDeal(c, { tenantId: tenant, contactId: duplicado.id, pipelineId: pipe.pipeline.id, title: 'Del duplicado' }),
    );
    await withTenant(app, tenant, (c) =>
      createActivity(c, { tenantId: tenant, contactId: duplicado.id, type: 'nota', title: 'Historia vieja' }),
    );

    await withTenant(app, tenant, (c) =>
      mergeContacts(c, { tenantId: tenant, primaryId: principal.id, duplicateId: duplicado.id, actor: 'sup' }),
    );

    const p = await admin.query('SELECT * FROM contacts WHERE id = $1', [principal.id]);
    expect(p.rows[0].name).toBe('Carmen Duplicada'); // absorbe lo que faltaba
    expect(p.rows[0].rut).toBe('11111111-1');
    expect(p.rows[0].channels).toEqual([
      { type: 'phone', value: '+56955550002', mergedFrom: duplicado.id },
    ]); // TODOS los identificadores quedan

    const d = await admin.query('SELECT merged_into FROM contacts WHERE id = $1', [duplicado.id]);
    expect(d.rows[0].merged_into).toBe(principal.id); // no se borra, apunta

    const historia = await admin.query(
      'SELECT count(*)::int AS n FROM deals WHERE contact_id = $1',
      [principal.id],
    );
    expect(historia.rows[0].n).toBe(1);
    const actividades = await admin.query(
      'SELECT count(*)::int AS n FROM activities WHERE contact_id = $1',
      [principal.id],
    );
    expect(actividades.rows[0].n).toBe(1);

    const evento = await admin.query(
      `SELECT count(*)::int AS n FROM outbox WHERE name = 'contact.merged' AND tenant_id = $1`,
      [tenant],
    );
    expect(evento.rows[0].n).toBe(1);
    const audit = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'contacts.merge'`,
      [tenant],
    );
    expect(audit.rows[0].n).toBe(1);

    // El teléfono del duplicado sigue llevando al principal (canales).
    const porTelefono = await withTenant(app, tenant, (c) =>
      ensureContactByPhone(c, { tenantId: tenant, phone: '+56955550002', origin: 'whatsapp' }),
    );
    expect(porTelefono.created).toBe(false);
    expect(porTelefono.contact.id).toBe(principal.id);

    // Fusionar de nuevo se rechaza: no hay des-fusión automática ni doble.
    await expect(
      withTenant(app, tenant, (c) =>
        mergeContacts(c, { tenantId: tenant, primaryId: principal.id, duplicateId: duplicado.id }),
      ),
    ).rejects.toThrow(/ya fue fusionado/);
  });
});
