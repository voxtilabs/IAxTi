import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';

export interface Invitation {
  id: string;
  tenantId: string;
  email: string | null;
  phone: string | null;
  roleName: string;
  token: string;
  expiresAt: Date;
}

/** Invita por correo o teléfono con rol sugerido; expira en 7 días (SPEC §9). */
export async function createInvitation(
  client: PoolClient,
  input: { tenantId: string; email?: string; phone?: string; roleName: string; actor?: string; requestId?: string },
): Promise<Invitation> {
  if (!input.email && !input.phone) {
    throw new Error('La invitación necesita correo o teléfono.');
  }
  const token = randomBytes(24).toString('base64url');
  const result = await client.query(
    `INSERT INTO invitations (tenant_id, email, phone, role_name, token)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, tenant_id, email, phone, role_name, token, expires_at`,
    [input.tenantId, input.email ?? null, input.phone ?? null, input.roleName, token],
  );
  const row = result.rows[0];
  await publishEvent(client, {
    name: 'user.invited',
    tenantId: input.tenantId,
    payload: { invitationId: row.id, roleName: input.roleName },
    actor: input.actor,
    requestId: input.requestId,
  });
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    phone: row.phone,
    roleName: row.role_name,
    token: row.token,
    expiresAt: row.expires_at,
  };
}

/**
 * Acepta la invitación: asigna el rol en el tenant (user_roles, un rol por
 * usuario por tenant) y publica user.joined_tenant. Vencida o ya usada, se
 * rechaza con mensaje accionable.
 */
export async function acceptInvitation(
  client: PoolClient,
  input: { token: string; userId: string; requestId?: string },
): Promise<{ tenantId: string; roleName: string }> {
  const found = await client.query(
    `SELECT id, tenant_id, role_name, expires_at, accepted_at
       FROM invitations WHERE token = $1 FOR UPDATE`,
    [input.token],
  );
  if (found.rowCount === 0) {
    throw new Error('Esa invitación no existe. Pide que te inviten de nuevo.');
  }
  const inv = found.rows[0];
  if (inv.accepted_at) {
    throw new Error('Esa invitación ya fue usada. Pide una nueva si necesitas entrar.');
  }
  if (new Date(inv.expires_at).getTime() < Date.now()) {
    throw new Error('Esa invitación venció (duran 7 días). Pide que te inviten de nuevo.');
  }

  const role = await client.query(
    'SELECT id FROM roles WHERE name = $1 AND tenant_id IS NULL AND base',
    [inv.role_name],
  );
  if (role.rowCount === 0) throw new Error(`Rol desconocido en la invitación: ${inv.role_name}`);

  await client.query(
    `INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id`,
    [inv.tenant_id, input.userId, role.rows[0].id],
  );
  await client.query('UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [
    inv.id,
    input.userId,
  ]);
  await publishEvent(client, {
    name: 'user.joined_tenant',
    tenantId: inv.tenant_id,
    payload: { userId: input.userId, roleName: inv.role_name },
    actor: input.userId,
    requestId: input.requestId,
  });
  return { tenantId: inv.tenant_id, roleName: inv.role_name };
}

/** Rol del usuario en el tenant (el guard lo consulta por request). */
export async function roleOf(
  client: PoolClient,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const result = await client.query(
    `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.tenant_id = $1 AND ur.user_id = $2`,
    [tenantId, userId],
  );
  return result.rowCount === 0 ? null : result.rows[0].name;
}

export async function upsertProfile(
  client: PoolClient,
  input: { userId: string; name?: string; phone?: string; locale?: string },
): Promise<void> {
  await client.query(
    `INSERT INTO user_profiles (user_id, name, phone, locale)
     VALUES ($1, $2, $3, COALESCE($4, 'es-CL'))
     ON CONFLICT (user_id) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, user_profiles.name),
           phone = COALESCE(EXCLUDED.phone, user_profiles.phone),
           locale = COALESCE($4, user_profiles.locale),
           updated_at = now()`,
    [input.userId, input.name ?? null, input.phone ?? null, input.locale ?? null],
  );
}
