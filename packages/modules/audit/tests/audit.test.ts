import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { writeAudit, verifyChain } from '../src/write';
import { searchAudit } from '../src/search';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

const base = {
  actor: 'user-1',
  actorKind: 'user' as const,
  resource: 'contact',
  result: 'ok',
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-audit') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  // La limpieza de un tenant de prueba borra su auditoría con rol admin y el
  // trigger lo impide a propósito: se elimina el trigger solo aquí, en test.
  await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete');
  await admin.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]);
  await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete');
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('audit_log', () => {
  it('escribe en la misma transacción: si la mutación falla, no hay entrada', async () => {
    await expect(
      withTenant(admin, tenant, async (c) => {
        await writeAudit(c, { ...base, tenantId: tenant, action: 'contact.create.fallida' });
        throw new Error('la mutación del caso de uso falló');
      }),
    ).rejects.toThrow('la mutación del caso de uso falló');

    const rows = await withTenant(admin, tenant, (c) =>
      c.query("SELECT 1 FROM audit_log WHERE action = 'contact.create.fallida'"),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('encadena hashes por tenant y la cadena verifica', async () => {
    for (let i = 1; i <= 3; i++) {
      await withTenant(admin, tenant, (c) =>
        writeAudit(c, { ...base, tenantId: tenant, action: `contact.update.${i}`, requestId: `req_${i}` }),
      );
    }
    const check = await withTenant(admin, tenant, (c) => verifyChain(c, tenant));
    expect(check).toEqual({ valid: true, entries: 3 });

    const chain = await withTenant(admin, tenant, (c) =>
      c.query('SELECT prev_hash, hash FROM audit_log WHERE tenant_id = $1 ORDER BY id', [tenant]),
    );
    expect(chain.rows[0].prev_hash).toBeNull();
    expect(chain.rows[1].prev_hash).toBe(chain.rows[0].hash);
    expect(chain.rows[2].prev_hash).toBe(chain.rows[1].hash);
  });

  it('UPDATE y DELETE están prohibidos incluso para el dueño de la tabla', async () => {
    await expect(
      admin.query("UPDATE audit_log SET result = 'alterado' WHERE tenant_id = $1", [tenant]),
    ).rejects.toThrow(/append-only/);
    await expect(
      admin.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]),
    ).rejects.toThrow(/append-only/);
  });

  it('la búsqueda filtra por actor, acción y fecha dentro del tenant', async () => {
    const porAccion = await withTenant(admin, tenant, (c) =>
      searchAudit(c, { action: 'contact.update.2' }),
    );
    expect(porAccion).toHaveLength(1);
    expect(porAccion[0].request_id).toBe('req_2');

    const porActor = await withTenant(admin, tenant, (c) =>
      searchAudit(c, { actor: 'user-1', from: new Date(Date.now() - 60_000) }),
    );
    expect(porActor.length).toBeGreaterThanOrEqual(3);

    const nadie = await withTenant(admin, tenant, (c) => searchAudit(c, { actor: 'fantasma' }));
    expect(nadie).toHaveLength(0);
  });

  it('una fila manipulada rompe la verificación de cadena', async () => {
    // Simular manipulación directa en la base (deshabilitando el trigger como
    // haría un atacante con acceso de superusuario): la cadena lo delata.
    await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete');
    await admin.query(
      "UPDATE audit_log SET result = 'alterado' WHERE tenant_id = $1 AND request_id = 'req_2'",
      [tenant],
    );
    await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete');

    const check = await withTenant(admin, tenant, (c) => verifyChain(c, tenant));
    expect(check.valid).toBe(false);
    expect(check.brokenAtId).toBeDefined();
  });
});
