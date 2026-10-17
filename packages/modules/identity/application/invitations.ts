import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { assignRole, membershipsOf, teamMemberships, removeMembership } from '@iaxti/module-authorization';

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

  await assignRole(client, {
    tenantId: inv.tenant_id, userId: input.userId, roleName: inv.role_name,
    actor: input.userId, requestId: input.requestId, createIfMissing: true,
  });
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

export interface Membership {
  tenantId: string;
  tenantName: string;
  roleName: string;
}

/**
 * Los negocios a los que pertenece un usuario, para el selector de tenant
 * del shell (un usuario puede estar en varios con roles distintos, SPEC §9).
 * El caller fija app.user_id desde la sesión autenticada dentro de una
 * transacción: la política permite solo las membresías de esa persona.
 */
export async function tenantsOf(client: PoolClient, userId: string): Promise<Membership[]> {
  const memberships = await membershipsOf(client, userId);
  if (!memberships.length) return [];
  const result = await client.query('SELECT id, name FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY name',
    [memberships.map((membership) => membership.tenantId)]);
  const roleNames = new Map(memberships.map((membership) => [membership.tenantId, membership.roleName]));
  return result.rows.map((row) => ({
    tenantId: row.id as string, tenantName: row.name as string, roleName: roleNames.get(row.id)!,
  }));
}

/** Rol del usuario en el tenant (el guard lo consulta por request). */
export async function roleOf(client: PoolClient, tenantId: string, userId: string): Promise<string | null> {
  return (await teamMemberships(client, tenantId, [userId])).find((member) => member.userId === userId)?.roleName ?? null;
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

export interface MiembroEquipo {
  userId: string;
  nombre: string | null;
  email: string | null;
  rol: string;
  desde: Date;
}

export interface InvitacionPendiente {
  id: string;
  email: string | null;
  phone: string | null;
  rol: string;
  expiraEl: Date;
  vencida: boolean;
}

/**
 * Quién tiene acceso hoy al negocio. El correo sale de la invitación que
 * cada persona aceptó: es lo único que sabemos de ella sin ir a Supabase.
 */
export async function listarEquipo(
  client: PoolClient,
  tenantId: string,
): Promise<MiembroEquipo[]> {
  const members = await teamMemberships(client, tenantId);
  if (!members.length) return [];
  const r = await client.query(
    `SELECT u.id AS user_id, p.name AS nombre,
            (SELECT i.email FROM invitations i
              WHERE i.tenant_id = $2 AND i.accepted_by = u.id AND i.email IS NOT NULL
              ORDER BY i.accepted_at DESC LIMIT 1) AS email
       FROM unnest($1::uuid[]) AS u(id)
       LEFT JOIN user_profiles p ON p.user_id = u.id`,
    [members.map((member) => member.userId), tenantId],
  );
  const profiles = new Map(r.rows.map((row) => [row.user_id, row]));
  return members.map((member) => ({
    userId: member.userId, nombre: profiles.get(member.userId)?.nombre ?? null,
    email: profiles.get(member.userId)?.email ?? null, rol: member.roleName, desde: member.joinedAt,
  }));
}

/** Invitaciones que todavía no se usan, con las vencidas marcadas. */
export async function listarInvitaciones(
  client: PoolClient,
  tenantId: string,
): Promise<InvitacionPendiente[]> {
  const r = await client.query(
    `SELECT id, email, phone, role_name, expires_at
       FROM invitations
      WHERE tenant_id = $1 AND accepted_at IS NULL
      ORDER BY created_at DESC`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    id: row.id as string,
    email: (row.email as string) ?? null,
    phone: (row.phone as string) ?? null,
    rol: row.role_name as string,
    expiraEl: row.expires_at as Date,
    vencida: new Date(row.expires_at).getTime() < Date.now(),
  }));
}

/** Cancela una invitación que todavía no se usó. */
export async function cancelarInvitacion(
  client: PoolClient,
  input: { tenantId: string; invitationId: string },
): Promise<boolean> {
  const r = await client.query(
    `DELETE FROM invitations
      WHERE tenant_id = $1 AND id = $2 AND accepted_at IS NULL`,
    [input.tenantId, input.invitationId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Saca a alguien del negocio. NO borra su historial: los mensajes que
 * escribió y las acciones que hizo siguen siendo parte del registro — lo
 * que se quita es el acceso.
 *
 * Nadie puede quitarse a sí mismo, y no se puede dejar el negocio sin
 * nadie con roles.manage: un tenant sin quien lo administre solo se arregla desde la
 * plataforma, y eso es un ticket de soporte que nadie quiere abrir.
 */
export async function quitarDelEquipo(
  client: PoolClient,
  input: { tenantId: string; userId: string; actor: string },
): Promise<void> {
  await removeMembership(client, input);
}
