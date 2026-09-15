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

export interface Membership {
  tenantId: string;
  tenantName: string;
  roleName: string;
}

/**
 * Los negocios a los que pertenece un usuario, para el selector de tenant
 * del shell (un usuario puede estar en varios con roles distintos, SPEC §9).
 * Se consulta con la conexión de servicio: cruza tenants ANTES de que exista
 * un tenant en contexto.
 */
export async function tenantsOf(client: PoolClient, userId: string): Promise<Membership[]> {
  const result = await client.query(
    `SELECT t.id AS tenant_id, t.name AS tenant_name, r.name AS role_name
       FROM user_roles ur
       JOIN tenants t ON t.id = ur.tenant_id
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1
      ORDER BY t.name`,
    [userId],
  );
  return result.rows.map((row) => ({
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    roleName: row.role_name,
  }));
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
  const r = await client.query(
    `SELECT ur.user_id, r.name AS rol, ur.created_at AS desde,
            p.name AS nombre,
            (SELECT i.email FROM invitations i
              WHERE i.tenant_id = ur.tenant_id AND i.accepted_by = ur.user_id
                AND i.email IS NOT NULL
              ORDER BY i.accepted_at DESC LIMIT 1) AS email
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN user_profiles p ON p.user_id = ur.user_id
      WHERE ur.tenant_id = $1
      ORDER BY ur.created_at`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    userId: row.user_id as string,
    nombre: (row.nombre as string) ?? null,
    email: (row.email as string) ?? null,
    rol: row.rol as string,
    desde: row.desde as Date,
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
 * ningún ADMIN: un tenant sin quien lo administre solo se arregla desde la
 * plataforma, y eso es un ticket de soporte que nadie quiere abrir.
 */
export async function quitarDelEquipo(
  client: PoolClient,
  input: { tenantId: string; userId: string; actor: string },
): Promise<void> {
  if (input.userId === input.actor) {
    throw new Error('No puedes quitarte a ti mismo: pídeselo a otra persona que administre.');
  }
  const objetivo = await client.query(
    `SELECT r.name AS rol FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.tenant_id = $1 AND ur.user_id = $2`,
    [input.tenantId, input.userId],
  );
  if (objetivo.rowCount === 0) {
    throw new Error('Esa persona no está en este negocio.');
  }
  if (objetivo.rows[0].rol === 'ADMIN') {
    const admins = await client.query(
      `SELECT count(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.tenant_id = $1 AND r.name = 'ADMIN'`,
      [input.tenantId],
    );
    if (admins.rows[0].n <= 1) {
      throw new Error(
        'Es la única persona que administra el negocio: nombra a otra antes de quitarla.',
      );
    }
  }
  await client.query('DELETE FROM user_roles WHERE tenant_id = $1 AND user_id = $2', [
    input.tenantId,
    input.userId,
  ]);
}
