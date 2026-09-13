import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/client';
import { withTenant } from '../src/tenant';
import { runMigrations } from '../src/migrate';

// Prueba del cerrojo 2 (SPEC §27): con app.tenant_id fijado, un tenant no ve
// ni escribe filas de otro; sin tenant en contexto, la tabla forzada a RLS no
// devuelve nada aunque el rol sea el dueño.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

// La app JAMÁS se conecta como superusuario ni como dueño de las tablas:
// un superusuario se salta RLS por completo (y FORCE solo alcanza al dueño).
// Este rol reproduce al "rol de aplicación" de producción.
const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@');

let admin: Pool;
let app: Pool;
let tenantA: string;
let tenantB: string;

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

  await admin.query(`
    CREATE TABLE IF NOT EXISTS rls_demo (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      dato      text NOT NULL
    )
  `);
  await admin.query('ALTER TABLE rls_demo ENABLE ROW LEVEL SECURITY');
  await admin.query('ALTER TABLE rls_demo FORCE ROW LEVEL SECURITY');
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rls_demo') THEN
        CREATE POLICY tenant_isolation ON rls_demo
          USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
          WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
      END IF;
    END $$
  `);
  await admin.query('GRANT USAGE ON SCHEMA public TO iaxti_app');
  await admin.query('GRANT SELECT, INSERT ON rls_demo TO iaxti_app');

  const a = await admin.query("INSERT INTO tenants (name) VALUES ('test-a') RETURNING id");
  const b = await admin.query("INSERT INTO tenants (name) VALUES ('test-b') RETURNING id");
  tenantA = a.rows[0].id;
  tenantB = b.rows[0].id;

  app = createPool(APP_URL);
});

afterAll(async () => {
  await app.end();
  await admin.query('DROP TABLE IF EXISTS rls_demo');
  await admin.query('DELETE FROM tenants WHERE id IN ($1, $2)', [tenantA, tenantB]);
  await admin.end();
});

describe('RLS por tenant', () => {
  it('el runner aplicó la migración de tenants y es idempotente', async () => {
    const otraVez = await runMigrations(admin);
    expect(otraVez).toHaveLength(0);
    const reg = await admin.query(
      "SELECT 1 FROM schema_migrations WHERE module = 'organizations' AND version = '0001_tenants.sql'",
    );
    expect(reg.rowCount).toBe(1);
  });

  it('cada tenant ve solo sus filas', async () => {
    await withTenant(app, tenantA, async (c) => {
      await c.query('INSERT INTO rls_demo (tenant_id, dato) VALUES ($1, $2)', [tenantA, 'a1']);
      await c.query('INSERT INTO rls_demo (tenant_id, dato) VALUES ($1, $2)', [tenantA, 'a2']);
    });
    await withTenant(app, tenantB, async (c) => {
      await c.query('INSERT INTO rls_demo (tenant_id, dato) VALUES ($1, $2)', [tenantB, 'b1']);
    });

    const vistasA = await withTenant(app, tenantA, (c) => c.query('SELECT dato FROM rls_demo ORDER BY dato'));
    const vistasB = await withTenant(app, tenantB, (c) => c.query('SELECT dato FROM rls_demo'));

    expect(vistasA.rows.map((r) => r.dato)).toEqual(['a1', 'a2']);
    expect(vistasB.rows.map((r) => r.dato)).toEqual(['b1']);
  });

  it('no se puede escribir una fila de otro tenant (WITH CHECK)', async () => {
    await expect(
      withTenant(app, tenantA, (c) =>
        c.query('INSERT INTO rls_demo (tenant_id, dato) VALUES ($1, $2)', [tenantB, 'intruso']),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('sin tenant en contexto no se ve ninguna fila, ni siendo dueño de la tabla', async () => {
    const sinContexto = await app.query('SELECT count(*)::int AS n FROM rls_demo');
    expect(sinContexto.rows[0].n).toBe(0);
  });
});
