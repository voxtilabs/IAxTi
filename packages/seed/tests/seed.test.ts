import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@iaxti/db';
import { seed, TENANT_NAME, USERS } from '../src/seed';

// En CI no hay SUPABASE_*: el seed usa uuids deterministas — la idempotencia
// se prueba igual. El login real se verifica contra staging a mano.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  // Hermético: el tenant demo puede existir con usuarios de OTRO modo
  // (uuids reales de Supabase vs deterministas); se parte de cero.
  const previo = await admin.query('SELECT id FROM tenants WHERE name = $1', [TENANT_NAME]);
  if ((previo.rowCount ?? 0) > 0) {
    const id = previo.rows[0].id;
    await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete');
    await admin.query('DELETE FROM audit_log WHERE tenant_id = $1', [id]);
    await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete');
    await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [id]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [id]);
    await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
  }
});

afterAll(async () => {
  await admin.end();
});

describe('seed (#18)', () => {
  it('crea el tenant demo con sus dos usuarios y roles', async () => {
    const result = await seed(admin);
    expect(result.users.map((u) => u.role).sort()).toEqual(['ADMIN', 'USER']);

    const roles = await admin.query(
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.tenant_id = $1 ORDER BY r.name`,
      [result.tenantId],
    );
    expect(roles.rows.map((r) => r.name)).toEqual(['ADMIN', 'USER']);

    const auditadas = await admin.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND actor_kind = 'system'",
      [result.tenantId],
    );
    expect(auditadas.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('correrlo de nuevo no duplica nada', async () => {
    const primero = await seed(admin);
    const segundo = await seed(admin);
    expect(segundo.tenantId).toBe(primero.tenantId);
    expect(segundo.users.map((u) => u.userId)).toEqual(primero.users.map((u) => u.userId));

    const tenants = await admin.query('SELECT count(*)::int AS n FROM tenants WHERE name = $1', [TENANT_NAME]);
    expect(tenants.rows[0].n).toBe(1);
    const membresias = await admin.query(
      'SELECT count(*)::int AS n FROM user_roles WHERE tenant_id = $1',
      [primero.tenantId],
    );
    expect(membresias.rows[0].n).toBe(USERS.length);
  });
});
