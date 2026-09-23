import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { assignRole } from '../application/roles';

/**
 * Nadie puede dejar al negocio sin quién lo administre (#460).
 *
 * Mientras asignar un rol era una llamada a la API a mano, esto era un
 * error difícil de cometer. Con un selector en la pantalla del equipo es
 * un clic — y quien se baja a sí mismo de ADMIN pierde el acceso a la
 * pantalla que usaría para arreglarlo.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let rolAdmin: string;
let rolUser: string;

async function alEquipo(userId: string, roleId: string) {
  await admin.query(
    'INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)',
    [tenant, userId, roleId],
  );
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('sin-admin') RETURNING id");
  tenant = t.rows[0].id;
  const roles = await admin.query(
    "SELECT id, name FROM roles WHERE tenant_id IS NULL AND base AND name IN ('ADMIN','USER')",
  );
  rolAdmin = roles.rows.find((r) => r.name === 'ADMIN').id;
  rolUser = roles.rows.find((r) => r.name === 'USER').id;
});

afterAll(async () => {
  await admin?.end();
});

describe('el último que administra', () => {
  it('no se puede bajar al único ADMIN', async () => {
    const solo = randomUUID();
    await alEquipo(solo, rolAdmin);
    await expect(
      withTenant(admin, tenant, (c) =>
        assignRole(c, { tenantId: tenant, userId: solo, roleId: rolUser, actor: solo }),
      ),
    ).rejects.toThrow(/administrar el negocio/);
    // Y el rechazo deshace el cambio: la transacción entera se va atrás.
    const r = await admin.query(
      'SELECT role_id FROM user_roles WHERE tenant_id = $1 AND user_id = $2',
      [tenant, solo],
    );
    expect(r.rows[0].role_id).toBe(rolAdmin);
  });

  it('con dos, cualquiera de los dos se puede bajar', async () => {
    const otro = randomUUID();
    await alEquipo(otro, rolAdmin);
    const primero = (
      await admin.query(
        'SELECT user_id FROM user_roles WHERE tenant_id = $1 AND role_id = $2 AND user_id <> $3',
        [tenant, rolAdmin, otro],
      )
    ).rows[0].user_id;
    await withTenant(admin, tenant, (c) =>
      assignRole(c, { tenantId: tenant, userId: primero, roleId: rolUser, actor: otro }),
    );
    const quedan = await admin.query(
      'SELECT count(*)::int AS n FROM user_roles WHERE tenant_id = $1 AND role_id = $2',
      [tenant, rolAdmin],
    );
    expect(quedan.rows[0].n).toBe(1);
  });

  it('un rol custom con roles.manage también cuenta como quien administra', async () => {
    // El negocio que armó su propio rol "socio" no tiene por qué llamarlo
    // ADMIN; lo que importa es quién puede repartir los roles.
    const custom = await admin.query(
      `INSERT INTO roles (tenant_id, name, base, permissions)
       VALUES ($1, 'socio', false, '["roles.manage"]'::jsonb) RETURNING id`,
      [tenant],
    );
    const socio = randomUUID();
    await alEquipo(socio, custom.rows[0].id);
    const ultimoAdmin = (
      await admin.query('SELECT user_id FROM user_roles WHERE tenant_id = $1 AND role_id = $2', [
        tenant,
        rolAdmin,
      ])
    ).rows[0].user_id;
    await withTenant(admin, tenant, (c) =>
      assignRole(c, { tenantId: tenant, userId: ultimoAdmin, roleId: rolUser, actor: socio }),
    );
    const admins = await admin.query(
      'SELECT count(*)::int AS n FROM user_roles WHERE tenant_id = $1 AND role_id = $2',
      [tenant, rolAdmin],
    );
    expect(admins.rows[0].n).toBe(0);
  });
});
