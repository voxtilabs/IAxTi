import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { customRolePermissions } from '@iaxti/module-authorization';
import { createApp } from '../src/main';
import { dbCustomPermissionsResolver, dbRoleResolver } from '../src/auth/role-resolver';

// Roles personalizados (#73): clonar, editar, asignar — y el guard
// respetando el rol custom DE VERDAD en la request siguiente.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID(); // ADMIN
const recepcionista = randomUUID(); // USER que pasará a rol custom

async function pedir(quien: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await firmar(quien)}`,
      'X-Tenant-Id': tenant,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-roles-custom') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'dueña@roles.cl', 'ADMIN'],
    [recepcionista, 'rece@roles.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256' }] });
  firmar = (sub) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setExpirationTime('5m')
      .sign(privateKey);
  // SIN cache en los resolvers del test: el cambio de rol se nota al tiro.
  app = await createApp({
    jwtVerify: async (token) => {
      const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
      return { userId: payload.sub as string };
    },
    resolveRole: (tenantId, userId) =>
      withTenant(admin, tenantId, async (c) => {
        const r = await c.query(
          `SELECT ro.name FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
            WHERE ur.tenant_id = $1 AND ur.user_id = $2`,
          [tenantId, userId],
        );
        return (r.rows[0]?.name as string) ?? null;
      }),
    // Sin cache, y ahora de verdad: `CreateAppOptions` no declaraba esta
    // opción, así que la app se quedaba con el resolver de la base —que
    // cachea 60 s— y este test comprobaba un cambio de permisos contra una
    // respuesta vieja. Pasaba según qué lectura hubiera calentado la cache.
    resolveCustomPermissions: (tenantId: string, roleName: string) =>
      withTenant(admin, tenantId, (c) => customRolePermissions(c, tenantId, roleName)),
  });
  void dbRoleResolver;
  void dbCustomPermissionsResolver;
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await admin.query(`DELETE FROM user_roles WHERE tenant_id = $1`, [tenant]);
  await admin.query(`DELETE FROM roles WHERE tenant_id = $1`, [tenant]);
  await admin.query(`DELETE FROM invitations WHERE tenant_id = $1`, [tenant]);
  await admin.query(`DELETE FROM outbox WHERE tenant_id = $1`, [tenant]);
  await admin.end();
});

describe('/v1/roles (#73)', () => {
  it('lista base + catálogo con módulo y estado; gestionar es del ADMIN', async () => {
    expect(
      (await pedir(recepcionista, '/roles', { method: 'POST', body: JSON.stringify({ name: 'X', cloneFrom: 'USER' }) })).status,
    ).toBe(403);

    const roles = await (await pedir(duena, '/roles')).json();
    expect(roles.map((r: { name: string }) => r.name)).toEqual(
      expect.arrayContaining(['ADMIN', 'SUPERVISOR', 'USER']),
    );
    expect(roles.find((r: { name: string }) => r.name === 'SUPERADMIN')).toBeUndefined();
    const user = roles.find((r: { name: string }) => r.name === 'USER');
    expect(user.base).toBe(true);
    expect(user.permissions).toContain('conversations.reply'); // calculado del traductor

    const catalogo = await (await pedir(duena, '/roles/catalogo')).json();
    const item = catalogo.find((c: { permission: string }) => c.permission === 'crm.contacts.read');
    expect(item.moduleId).toBe('crm');
    expect(typeof item.active).toBe('boolean');
  });

  it('clona, edita permisos (los base inmutables) y el guard OBEDECE al custom', async () => {
    const creado = await pedir(duena, '/roles', {
      method: 'POST',
      body: JSON.stringify({ name: 'Recepcionista', cloneFrom: 'USER' }),
    });
    expect(creado.status).toBe(201);
    const rol = await creado.json();
    expect(rol.clonedFrom).toBe('USER');
    expect(rol.permissions).toContain('conversations.reply'); // heredó del USER

    // Editar: solo lectura de conversaciones — sin responder ni contactos.
    const editado = await pedir(duena, `/roles/${rol.id}`, {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['tenant.read', 'conversations.read'] }),
    });
    expect(editado.status).toBe(200);

    // Un base no se edita ni con el id correcto.
    const roles = await (await pedir(duena, '/roles')).json();
    const baseUser = roles.find((r: { name: string }) => r.name === 'USER');
    expect(
      (await pedir(duena, `/roles/${baseUser.id}`, { method: 'PUT', body: JSON.stringify({ permissions: [] }) })).status,
    ).toBe(400);

    // Asignar y probar EL GUARD: lee sí, responde no.
    const asignado = await pedir(duena, '/roles/assign', {
      method: 'POST',
      body: JSON.stringify({ userId: recepcionista, roleId: rol.id }),
    });
    expect(asignado.status).toBe(201);

    expect((await pedir(recepcionista, '/conversations')).status).toBe(200); // conversations.read ✓
    expect((await pedir(recepcionista, '/contacts')).status).toBe(403); // sin crm.contacts.read

    // Auditado + eventos.
    const eventos = await admin.query(
      `SELECT name FROM outbox WHERE tenant_id = $1 AND name IN ('role.created','role.assigned') ORDER BY id`,
      [tenant],
    );
    expect(eventos.rows.map((e) => e.name)).toEqual(['role.created', 'role.assigned']);
    const audit = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action LIKE 'authorization.role%'`,
      [tenant],
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(3); // create + update + assign
  });

  it('permisos piratas y de plataforma se rechazan', async () => {
    const roles = await (await pedir(duena, '/roles')).json();
    const custom = roles.find((r: { base: boolean }) => !r.base);
    expect(
      (await pedir(duena, `/roles/${custom.id}`, { method: 'PUT', body: JSON.stringify({ permissions: ['superpoderes.todo'] }) })).status,
    ).toBe(400);
    expect(
      (await pedir(duena, `/roles/${custom.id}`, { method: 'PUT', body: JSON.stringify({ permissions: ['platform.tenants'] }) })).status,
    ).toBe(400);
  });
});
