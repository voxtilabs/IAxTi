import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { acceptInvitation, createInvitation, roleOf, upsertProfile } from '../application/invitations';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const userId = randomUUID();

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-identity') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM invitations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM user_profiles WHERE user_id = $1', [userId]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('identity: invitaciones', () => {
  let token: string;

  it('la invitación nace con rol, token y 7 días de vigencia, y publica user.invited', async () => {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email: 'vende@negocio.cl', roleName: 'USER' }),
    );
    token = inv.token;
    const dias = (inv.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(6.9);
    expect(dias).toBeLessThan(7.1);

    const evento = await admin.query(
      "SELECT 1 FROM outbox WHERE name = 'user.invited' AND tenant_id = $1",
      [tenant],
    );
    expect(evento.rowCount).toBe(1);
  });

  it('aceptar asigna el rol en el tenant y publica user.joined_tenant', async () => {
    const result = await withTenant(admin, tenant, (c) =>
      acceptInvitation(c, { token, userId }),
    );
    expect(result).toEqual({ tenantId: tenant, roleName: 'USER' });
    expect(await withTenant(admin, tenant, (c) => roleOf(c, tenant, userId))).toBe('USER');

    const evento = await admin.query(
      "SELECT 1 FROM outbox WHERE name = 'user.joined_tenant' AND tenant_id = $1",
      [tenant],
    );
    expect(evento.rowCount).toBe(1);
  });

  it('una invitación usada no se acepta dos veces', async () => {
    await expect(
      withTenant(admin, tenant, (c) => acceptInvitation(c, { token, userId: randomUUID() })),
    ).rejects.toThrow(/ya fue usada/);
  });

  it('una invitación vencida se rechaza con mensaje accionable', async () => {
    const vencida = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email: 'tarde@negocio.cl', roleName: 'USER' }),
    );
    await admin.query("UPDATE invitations SET expires_at = now() - interval '1 hour' WHERE id = $1", [
      vencida.id,
    ]);
    await expect(
      withTenant(admin, tenant, (c) => acceptInvitation(c, { token: vencida.token, userId })),
    ).rejects.toThrow(/venció/);
  });

  it('sin correo ni teléfono no hay invitación; token inexistente no entra', async () => {
    await expect(
      withTenant(admin, tenant, (c) => createInvitation(c, { tenantId: tenant, roleName: 'USER' })),
    ).rejects.toThrow(/correo o teléfono/);
    await expect(
      withTenant(admin, tenant, (c) => acceptInvitation(c, { token: 'no-existe', userId })),
    ).rejects.toThrow(/no existe/);
  });

  it('el perfil se upserta sin pisar campos con null', async () => {
    const client = await admin.connect();
    try {
      await upsertProfile(client, { userId, name: 'Vendedora Test', phone: '+56911111111' });
      await upsertProfile(client, { userId, name: undefined });
      const row = await client.query('SELECT name, phone, locale FROM user_profiles WHERE user_id = $1', [userId]);
      expect(row.rows[0]).toEqual({ name: 'Vendedora Test', phone: '+56911111111', locale: 'es-CL' });
    } finally {
      client.release();
    }
  });
});
