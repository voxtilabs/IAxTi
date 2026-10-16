import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, estadoRls, runMigrations, withAuthenticatedUser, withTenant } from '@iaxti/db';
import { assignRole, usersWithPermission } from '@iaxti/module-authorization';
import { acceptInvitation, createInvitation, listarEquipo, quitarDelEquipo, roleOf, tenantsOf } from '../application/invitations';
import { quienesSon } from '../application/quien';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const role = `test_membership_${randomUUID().replaceAll('-', '')}`;
let owner: Pool;
let app: Pool;
let a: string;
let b: string;
let custom: string;
const adminA = randomUUID();
const adminB = randomUUID();
const member = randomUUID();
const second = randomUUID();

beforeAll(async () => {
  owner = createPool(ADMIN_URL);
  await runMigrations(owner);
  await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOSUPERUSER NOBYPASSRLS`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, `//${role}:${role}@`));
  a = (await owner.query("INSERT INTO tenants(name) VALUES ('memberships-a') RETURNING id")).rows[0].id;
  b = (await owner.query("INSERT INTO tenants(name) VALUES ('memberships-b') RETURNING id")).rows[0].id;
  for (const [tenant, user] of [[a, adminA], [b, adminB]]) {
    await owner.query(`INSERT INTO user_roles(tenant_id,user_id,role_id)
      SELECT $1,$2,id FROM roles WHERE base AND name = 'ADMIN'`, [tenant, user]);
  }
  await owner.query("INSERT INTO roles(tenant_id,name,permissions) VALUES($1,'Privado B','[]')", [b]);
  for (const tenant of [a, b]) {
    await owner.query("INSERT INTO contacts(tenant_id,phone,name) VALUES($1,'+56999999000','Privado')", [tenant]);
    await withTenant(owner, tenant, (c) => createInvitation(c, { tenantId: tenant, email: 'private@example.test', roleName: 'USER' }));
  }
  custom = (await owner.query(`INSERT INTO roles(tenant_id,name,permissions)
    VALUES ($1,'Coordinación','["conversations.reply","conversations.assign"]') RETURNING id`, [a])).rows[0].id;
  await owner.query('INSERT INTO user_roles(tenant_id,user_id,role_id) VALUES ($1,$2,$3)', [a, member, custom]);
  await owner.query(`INSERT INTO user_roles(tenant_id,user_id,role_id)
    SELECT $1,$2,id FROM roles WHERE base AND name='USER'`, [b, member]);
});
afterAll(async () => {
  await app?.end();
  await owner.query(`DROP OWNED BY ${role}`);
  await owner.query(`DROP ROLE ${role}`);
  await owner.end();
});

describe('contratos authorization bajo RLS real (#902)', () => {
  it('el rol de prueba no puede omitir RLS', async () => {
    expect(await estadoRls(app)).toMatchObject({ superusuario: false, bypassrls: false, seSalta: false });
    expect((await app.query('SELECT * FROM user_roles')).rows).toEqual([]);
  });

  it('el traductor incluye custom, respeta catálogo y no atraviesa tenants', async () => {
    expect(await withTenant(app, a, (c) => usersWithPermission(c, a, 'conversations.assign'))).toEqual([adminA, member].sort());
    expect(await withTenant(app, a, (c) => usersWithPermission(c, a, 'inventado.permiso'))).toEqual([]);
    expect(await withTenant(app, a, (c) => usersWithPermission(c, b, 'conversations.assign'))).toEqual([]);
    expect(await withTenant(app, b, (c) => usersWithPermission(c, b, 'conversations.assign'))).toEqual([adminB]);
  });

  it('descubre solo negocios de la sesión, incluido rol propio, sin abrir datos de negocio', async () => {
    const memberships = await withAuthenticatedUser(app, member, async (c) => {
      expect(await tenantsOf(c, adminB)).toEqual([]);
      expect((await c.query('SELECT * FROM contacts')).rows).toEqual([]);
      expect((await c.query('SELECT * FROM invitations')).rows).toEqual([]);
      expect((await c.query('SELECT * FROM roles WHERE tenant_id = $1', [b])).rows).toEqual([]);
      return tenantsOf(c, member);
    });
    expect(memberships).toEqual([
      { tenantId: a, tenantName: 'memberships-a', roleName: 'Coordinación' },
      { tenantId: b, tenantName: 'memberships-b', roleName: 'USER' },
    ]);
    expect(await withAuthenticatedUser(app, randomUUID(), (c) => tenantsOf(c, member))).toEqual([]);
    expect((await app.query('SELECT * FROM user_roles')).rows).toEqual([]);
    await expect(withAuthenticatedUser(app, member, async (c) => {
      expect((await tenantsOf(c, member)).length).toBe(2);
      throw new Error('fallo después de leer');
    })).rejects.toThrow('fallo después de leer');
    expect((await app.query('SELECT * FROM user_roles')).rows).toEqual([]);
  });

  it('el contexto de sesión no concede escrituras ni amplía un tenant elegido', async () => {
    await expect(withAuthenticatedUser(app, member, (c) => c.query(
      'INSERT INTO user_roles(tenant_id,user_id,role_id) VALUES($1,$2,$3)', [a, randomUUID(), custom],
    ))).rejects.toThrow(/row-level security/);
    await withAuthenticatedUser(app, member, async (c) => {
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [a]);
      expect((await tenantsOf(c, member)).map((m) => m.tenantId)).toEqual([a]);
    });
  });

  it('identity presenta equipo y autores por contrato sin mezclar membresías', async () => {
    const team = await withTenant(app, a, (c) => listarEquipo(c, a));
    expect(team.map((m) => m.userId).sort()).toEqual([adminA, member].sort());
    expect(await withTenant(app, a, (c) => roleOf(c, b, member))).toBeNull();
    const people = await withTenant(app, a, (c) => quienesSon(c, a, [member, adminB]));
    expect(people.get(member)?.enElEquipo).toBe(true);
    expect(people.get(adminB)?.enElEquipo).toBe(false);
  });

  it('un fallo después de assignRole revierte alta, marca, auditoría y ambos eventos', async () => {
    const inv = await withTenant(app, a, (c) => createInvitation(c, {
      tenantId: a, email: 'atomic@example.test', roleName: 'Coordinación', actor: adminA,
    }));
    const check = async () => {
      expect((await owner.query('SELECT 1 FROM user_roles WHERE tenant_id=$1 AND user_id=$2', [a, second])).rowCount).toBe(0);
      expect((await owner.query('SELECT accepted_at,accepted_by FROM invitations WHERE id=$1', [inv.id])).rows[0]).toEqual({ accepted_at: null, accepted_by: null });
      expect((await owner.query('SELECT 1 FROM audit_log WHERE tenant_id=$1 AND resource_id=$2', [a, second])).rowCount).toBe(0);
      expect((await owner.query("SELECT 1 FROM outbox WHERE tenant_id=$1 AND payload->>'userId'=$2", [a, second])).rowCount).toBe(0);
    };
    await expect(withTenant(app, a, async (c) => {
      // El cliente ajeno falla justo al marcar la invitación, tras el INSERT,
      // audit y role.assigned reales. Ningún trigger compartido se modifica.
      const failing = new Proxy(c, { get(target, property) {
        if (property !== 'query') return Reflect.get(target, property);
        return (...args: Parameters<PoolClient['query']>) => {
          if (String(args[0]).startsWith('UPDATE invitations SET accepted_at')) throw new Error('fallo al marcar');
          return Reflect.apply(target.query, target, args);
        };
      } });
      return acceptInvitation(failing, { token: inv.token, userId: second });
    })).rejects.toThrow('fallo al marcar');
    await check();
    await expect(withTenant(app, a, async (c) => {
      await acceptInvitation(c, { token: inv.token, userId: second });
      throw new Error('fallo del caller después de aceptar');
    })).rejects.toThrow('fallo del caller');
    await check();
    await withTenant(app, a, (c) => acceptInvitation(c, { token: inv.token, userId: second }));
    expect(await withTenant(app, a, (c) => roleOf(c, a, second))).toBe('Coordinación');
    expect((await owner.query('SELECT accepted_by FROM invitations WHERE id=$1', [inv.id])).rows[0].accepted_by).toBe(second);
    expect((await owner.query("SELECT action FROM audit_log WHERE tenant_id=$1 AND resource_id=$2", [a, second])).rows.map((r) => r.action)).toEqual(['authorization.role.assign']);
    expect((await owner.query("SELECT name FROM outbox WHERE tenant_id=$1 AND payload->>'userId'=$2 ORDER BY id", [a, second])).rows.map((r) => r.name)).toEqual(['role.assigned', 'user.joined_tenant']);
    await expect(withTenant(app, a, (c) => acceptInvitation(c, { token: inv.token, userId: second }))).rejects.toThrow(/ya fue usada/);
  });

  it('aceptar otra invitación tampoco puede degradar al último administrador', async () => {
    const inv = await withTenant(app, a, (c) => createInvitation(c, {
      tenantId: a, email: 'admin@example.test', roleName: 'USER', actor: adminA,
    }));
    await expect(withTenant(app, a, (c) => acceptInvitation(c, { token: inv.token, userId: adminA })))
      .rejects.toThrow(/administrar el negocio/);
    expect(await withTenant(app, a, (c) => roleOf(c, a, adminA))).toBe('ADMIN');
    expect((await owner.query('SELECT accepted_at FROM invitations WHERE id=$1', [inv.id])).rows[0].accepted_at).toBeNull();
  });

  it('dos degradaciones simultáneas no pueden dejar al equipo sin administrador', async () => {
    const tenant = (await owner.query("INSERT INTO tenants(name) VALUES('concurrent-admins') RETURNING id")).rows[0].id;
    const first = randomUUID();
    const last = randomUUID();
    for (const user of [first, last]) {
      await owner.query(`INSERT INTO user_roles(tenant_id,user_id,role_id)
        SELECT $1,$2,id FROM roles WHERE base AND name='ADMIN'`, [tenant, user]);
    }
    const results = await Promise.allSettled([first, last].map((user) => withTenant(app, tenant, (c) =>
      assignRole(c, { tenantId: tenant, userId: user, roleName: 'USER', actor: user }))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await withTenant(app, tenant, (c) => usersWithPermission(c, tenant, 'roles.manage'))).toHaveLength(1);
  });

  it('revocar usa el contrato, audita y protege a la última persona que administra', async () => {
    await expect(withTenant(app, a, (c) => quitarDelEquipo(c, { tenantId: a, userId: adminA, actor: member }))).rejects.toThrow(/única persona/);
    expect(await withTenant(app, a, (c) => roleOf(c, a, adminA))).toBe('ADMIN');
    await withTenant(app, a, (c) => quitarDelEquipo(c, { tenantId: a, userId: second, actor: adminA }));
    expect(await withTenant(app, a, (c) => roleOf(c, a, second))).toBeNull();
    expect((await owner.query("SELECT 1 FROM audit_log WHERE tenant_id=$1 AND resource_id=$2 AND action='authorization.membership.remove'", [a, second])).rowCount).toBe(1);
  });
});
