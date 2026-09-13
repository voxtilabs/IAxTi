import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import { BASE_ROLES, baseRoleHasPermission } from '../domain/base-roles';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
});

afterAll(async () => {
  await admin.end();
});

describe('paquetes de permisos de los roles base', () => {
  const catalog = new Set([
    'users.read',
    'users.manage',
    'tenant.read',
    'tenant.billing',
    'teams.manage',
    'roles.manage',
    'apikeys.manage',
    'audit.read',
    'platform.tenants',
  ]);

  it('ADMIN tiene todo el tenant y nada de plataforma', () => {
    expect(baseRoleHasPermission('ADMIN', 'users.manage', catalog)).toBe(true);
    expect(baseRoleHasPermission('ADMIN', 'apikeys.manage', catalog)).toBe(true);
    expect(baseRoleHasPermission('ADMIN', 'platform.tenants', catalog)).toBe(false);
  });

  it('SUPERADMIN tiene plataforma y lectura de audit, no operación del tenant', () => {
    expect(baseRoleHasPermission('SUPERADMIN', 'platform.tenants', catalog)).toBe(true);
    expect(baseRoleHasPermission('SUPERADMIN', 'audit.read', catalog)).toBe(true);
    expect(baseRoleHasPermission('SUPERADMIN', 'users.manage', catalog)).toBe(false);
  });

  it('SUPERVISOR coordina sin configurar; USER opera lo propio', () => {
    expect(baseRoleHasPermission('SUPERVISOR', 'users.read', catalog)).toBe(true);
    expect(baseRoleHasPermission('SUPERVISOR', 'roles.manage', catalog)).toBe(false);
    expect(baseRoleHasPermission('USER', 'tenant.read', catalog)).toBe(true);
    expect(baseRoleHasPermission('USER', 'users.read', catalog)).toBe(false);
  });

  it('un permiso fuera del catálogo jamás se concede, a nadie', () => {
    for (const role of BASE_ROLES) {
      expect(baseRoleHasPermission(role, 'inventado.x.y', catalog)).toBe(false);
    }
  });
});

describe('esquema de authorization', () => {
  it('los cuatro roles base quedan sembrados, globales e inmutables por rol de app', async () => {
    const roles = await admin.query(
      'SELECT name FROM roles WHERE tenant_id IS NULL AND base ORDER BY name',
    );
    expect(roles.rows.map((r) => r.name)).toEqual(['ADMIN', 'SUPERADMIN', 'SUPERVISOR', 'USER']);
  });

  it('api_keys existe con hash, scopes, expiración y revocación (solo esquema, #24)', async () => {
    const cols = await admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'api_keys'`,
    );
    const nombres = cols.rows.map((c) => c.column_name);
    for (const col of ['tenant_id', 'key_hash', 'scopes', 'expires_at', 'last_used_at', 'revoked_at']) {
      expect(nombres).toContain(col);
    }
  });

  it('user_roles impone un rol por usuario por tenant', async () => {
    const pk = await admin.query(
      `SELECT array_agg(a.attname::text ORDER BY a.attname) AS cols
         FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'user_roles'::regclass AND i.indisprimary`,
    );
    expect(pk.rows[0].cols).toEqual(['tenant_id', 'user_id']);
  });
});
