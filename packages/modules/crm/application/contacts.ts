import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { isOptOutMessage, normalizePhone, normalizeRut } from '../domain/validation';

export type ContactOrigin =
  | 'whatsapp'
  | 'webchat'
  | 'importado'
  | 'manual'
  | 'instagram'
  | 'messenger';

/** Canales que identifican a un contacto (#74). El simulador imita WhatsApp. */
export type IdentityChannel = 'whatsapp' | 'webchat' | 'instagram' | 'messenger' | 'simulador';

export interface Contact {
  id: string;
  tenantId: string;
  /**
   * Teléfono E.164: es la identidad del canal WhatsApp, no la del contacto.
   * null para quien llegó por webchat con correo (#46) o por Instagram y
   * Messenger, que solo traen un id de chat (#74).
   */
  phone: string | null;
  name: string | null;
  email: string | null;
  rut: string | null;
  ownerId: string | null;
  origin: ContactOrigin;
  optInAt: Date | null;
  optedOutAt: Date | null;
  custom: Record<string, unknown>;
}

function rowToContact(row: Record<string, unknown>): Contact {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    phone: (row.phone as string) ?? null,
    name: (row.name as string) ?? null,
    email: (row.email as string) ?? null,
    rut: (row.rut as string) ?? null,
    ownerId: (row.owner_id as string) ?? null,
    origin: row.origin as ContactOrigin,
    optInAt: (row.opt_in_at as Date) ?? null,
    optedOutAt: (row.opted_out_at as Date) ?? null,
    custom: (row.custom as Record<string, unknown>) ?? {},
  };
}

export interface CreateContactInput {
  tenantId: string;
  phone: string;
  name?: string;
  email?: string;
  rut?: string;
  ownerId?: string;
  origin?: ContactOrigin;
  requestId?: string;
  actor?: string;
}

export async function createContact(client: PoolClient, input: CreateContactInput): Promise<Contact> {
  const phone = normalizePhone(input.phone);
  const rut = input.rut ? normalizeRut(input.rut) : null;
  const result = await client.query(
    `INSERT INTO contacts (tenant_id, phone, name, email, rut, owner_id, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [input.tenantId, phone, input.name ?? null, input.email ?? null, rut, input.ownerId ?? null, input.origin ?? 'manual'],
  );
  const contact = rowToContact(result.rows[0]);
  await publishEvent(client, {
    name: 'contact.created',
    tenantId: input.tenantId,
    payload: { contactId: contact.id, origin: contact.origin },
    actor: input.actor,
    requestId: input.requestId,
  });
  return contact;
}

/**
 * Registra la identidad de un contacto en un canal. Idempotente: la misma
 * identidad dos veces no duplica ni pisa a quién apunta.
 */
export async function linkIdentity(
  client: PoolClient,
  input: { tenantId: string; contactId: string; channel: IdentityChannel; identity: string },
): Promise<void> {
  await client.query(
    `INSERT INTO contact_identities (tenant_id, contact_id, channel, identity)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, channel, identity) DO NOTHING`,
    [input.tenantId, input.contactId, input.channel, input.identity],
  );
}

/**
 * El camino de los canales (SPEC §10, #74): al llegar un mensaje de alguien
 * desconocido se crea el contacto, lo identifique un teléfono o un id de chat.
 * Idempotente por (tenant, canal, identidad).
 *
 * WhatsApp y el simulador siguen resolviéndose por teléfono —es la identidad
 * de ese canal y el dedupe histórico vive ahí—; Instagram y Messenger, por la
 * tabla de identidades, porque no traen teléfono que valga.
 */
export async function ensureContactByIdentity(
  client: PoolClient,
  input: {
    tenantId: string;
    channel: IdentityChannel;
    identity: string;
    origin: ContactOrigin;
    name?: string;
    requestId?: string;
  },
): Promise<{ contact: Contact; created: boolean }> {
  if (input.channel === 'whatsapp' || input.channel === 'simulador') {
    const res = await ensureContactByPhone(client, {
      tenantId: input.tenantId,
      phone: input.identity,
      origin: input.origin,
      requestId: input.requestId,
    });
    await linkIdentity(client, {
      tenantId: input.tenantId,
      contactId: res.contact.id,
      channel: 'whatsapp',
      identity: res.contact.phone ?? normalizePhone(input.identity),
    });
    return res;
  }

  const existing = await client.query(
    `SELECT k.* FROM contact_identities i
       JOIN contacts k ON k.id = i.contact_id
      WHERE i.tenant_id = $1 AND i.channel = $2 AND i.identity = $3`,
    [input.tenantId, input.channel, input.identity],
  );
  if ((existing.rowCount ?? 0) > 0) {
    const row = existing.rows[0];
    // Un contacto fusionado apunta a su principal (#34): el canal siempre
    // conversa con el que quedó vivo.
    if (row.merged_into) {
      const principal = await client.query(
        'SELECT * FROM contacts WHERE tenant_id = $1 AND id = $2',
        [input.tenantId, row.merged_into],
      );
      if ((principal.rowCount ?? 0) > 0) {
        return { contact: rowToContact(principal.rows[0]), created: false };
      }
    }
    return { contact: rowToContact(row), created: false };
  }

  // Sin teléfono ni correo: el contacto nace con el nombre que dé el canal, o
  // sin nombre. Inventarle un teléfono sería mentirle a la ficha.
  const result = await client.query(
    `INSERT INTO contacts (tenant_id, phone, name, origin)
     VALUES ($1, NULL, $2, $3) RETURNING *`,
    [input.tenantId, input.name ?? null, input.origin],
  );
  const contact = rowToContact(result.rows[0]);
  await linkIdentity(client, {
    tenantId: input.tenantId,
    contactId: contact.id,
    channel: input.channel,
    identity: input.identity,
  });
  await publishEvent(client, {
    name: 'contact.created',
    tenantId: input.tenantId,
    payload: { contactId: contact.id, origin: contact.origin },
    actor: 'system',
    requestId: input.requestId,
  });
  return { contact, created: true };
}

/**
 * Identidad del contacto en un canal, para responderle por donde escribió.
 * WhatsApp cae al teléfono cuando el contacto es anterior a la tabla.
 */
export async function identityFor(
  client: PoolClient,
  input: { tenantId: string; contactId: string; channel: IdentityChannel },
): Promise<string | null> {
  const r = await client.query(
    `SELECT identity FROM contact_identities
      WHERE tenant_id = $1 AND contact_id = $2 AND channel = $3 LIMIT 1`,
    [input.tenantId, input.contactId, input.channel],
  );
  if ((r.rowCount ?? 0) > 0) return r.rows[0].identity as string;
  const k = await client.query('SELECT phone FROM contacts WHERE tenant_id = $1 AND id = $2', [
    input.tenantId,
    input.contactId,
  ]);
  return (k.rows[0]?.phone as string) ?? null;
}

/**
 * El camino de los canales (SPEC §10): al llegar un mensaje de un teléfono
 * desconocido se crea el contacto. Idempotente por (tenant, phone).
 */
export async function ensureContactByPhone(
  client: PoolClient,
  input: { tenantId: string; phone: string; origin: ContactOrigin; requestId?: string },
): Promise<{ contact: Contact; created: boolean }> {
  const phone = normalizePhone(input.phone);
  const existing = await client.query(
    'SELECT * FROM contacts WHERE tenant_id = $1 AND phone = $2',
    [input.tenantId, phone],
  );
  if ((existing.rowCount ?? 0) > 0) {
    const row = existing.rows[0];
    // Un contacto fusionado apunta a su principal (#34): el canal siempre
    // conversa con el que quedó vivo.
    if (row.merged_into) {
      const principal = await client.query(
        'SELECT * FROM contacts WHERE tenant_id = $1 AND id = $2',
        [input.tenantId, row.merged_into],
      );
      if ((principal.rowCount ?? 0) > 0) {
        return { contact: rowToContact(principal.rows[0]), created: false };
      }
    }
    return { contact: rowToContact(row), created: false };
  }
  const contact = await createContact(client, { ...input, phone, actor: 'system' });
  return { contact, created: true };
}

export async function updateContact(
  client: PoolClient,
  input: {
    tenantId: string;
    contactId: string;
    name?: string;
    email?: string;
    rut?: string;
    ownerId?: string;
    custom?: Record<string, unknown>;
    requestId?: string;
    actor?: string;
  },
): Promise<Contact> {
  const rut = input.rut !== undefined ? (input.rut ? normalizeRut(input.rut) : null) : undefined;
  const result = await client.query(
    `UPDATE contacts SET
       name = COALESCE($3, name),
       email = COALESCE($4, email),
       rut = CASE WHEN $5::boolean THEN $6 ELSE rut END,
       owner_id = COALESCE($7, owner_id),
       custom = custom || COALESCE($8::jsonb, '{}'::jsonb),
       updated_at = now(),
       last_activity_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [
      input.tenantId,
      input.contactId,
      input.name ?? null,
      input.email ?? null,
      rut !== undefined,
      rut ?? null,
      input.ownerId ?? null,
      input.custom ? JSON.stringify(input.custom) : null,
    ],
  );
  if (result.rowCount === 0) throw new Error('No encontramos ese contacto. Puede que se haya eliminado.');
  const contact = rowToContact(result.rows[0]);
  await publishEvent(client, {
    name: 'contact.updated',
    tenantId: input.tenantId,
    payload: { contactId: contact.id },
    actor: input.actor,
    requestId: input.requestId,
  });
  return contact;
}

/** Opt-in con evidencia (fecha, canal, evidencia — SPEC §8). */
export async function registerOptIn(
  client: PoolClient,
  input: { tenantId: string; contactId: string; channel: string; evidence: string },
): Promise<void> {
  await client.query(
    `UPDATE contacts SET opt_in_at = now(), opt_in_channel = $3, opt_in_evidence = $4,
            opted_out_at = NULL, updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.contactId, input.channel, input.evidence],
  );
}

/** Marca opt-out y publica contact.opted_out. */
export async function optOut(
  client: PoolClient,
  input: { tenantId: string; contactId: string; reason: string; requestId?: string },
): Promise<void> {
  await client.query(
    'UPDATE contacts SET opted_out_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2',
    [input.tenantId, input.contactId],
  );
  await publishEvent(client, {
    name: 'contact.opted_out',
    tenantId: input.tenantId,
    payload: { contactId: input.contactId, reason: input.reason },
    requestId: input.requestId,
  });
}

/**
 * Camino automático (SPEC §8): si el mensaje entrante es "BASTA"/"STOP"/etc.,
 * marca el opt-out. Los canales lo llaman con cada mensaje.
 */
export async function handleInboundForConsent(
  client: PoolClient,
  input: { tenantId: string; contactId: string; text: string; requestId?: string },
): Promise<{ optedOut: boolean }> {
  if (!isOptOutMessage(input.text)) return { optedOut: false };
  await optOut(client, {
    tenantId: input.tenantId,
    contactId: input.contactId,
    reason: `mensaje del contacto: "${input.text.slice(0, 80)}"`,
    requestId: input.requestId,
  });
  return { optedOut: true };
}

/** ¿Puede recibir mensajes iniciados por el negocio? (SPEC §8) */
export async function canReceiveBusinessInitiated(
  client: PoolClient,
  tenantId: string,
  contactId: string,
): Promise<boolean> {
  const result = await client.query(
    'SELECT opt_in_at, opted_out_at, origin FROM contacts WHERE tenant_id = $1 AND id = $2',
    [tenantId, contactId],
  );
  if (result.rowCount === 0) return false;
  const { opt_in_at, opted_out_at, origin } = result.rows[0];
  if (opted_out_at) return false;
  // Escribió primero (origen de canal) o dio opt-in registrado.
  return Boolean(opt_in_at) || origin === 'whatsapp' || origin === 'webchat';
}

/** Lista para /contactos (#34): búsqueda por nombre o teléfono, cursor. */
export async function listContacts(
  client: PoolClient,
  tenantId: string,
  filters: { q?: string; cursor?: string; limit?: number } = {},
): Promise<{ items: Contact[]; nextCursor: string | null }> {
  const limit = Math.min(filters.limit ?? 25, 100);
  const params: unknown[] = [tenantId];
  const where = ['tenant_id = $1', 'merged_into IS NULL'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(name ILIKE $${params.length} OR phone LIKE $${params.length})`);
  }
  if (filters.cursor) {
    const [ts, id] = Buffer.from(filters.cursor, 'base64url').toString().split('|');
    if (!ts || !id) throw new Error('Ese cursor no es válido. Vuelve a la primera página.');
    params.push(ts, id);
    where.push(`(last_activity_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const r = await client.query(
    `SELECT * FROM contacts WHERE ${where.join(' AND ')}
      ORDER BY last_activity_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  const last = rows.at(-1);
  return {
    items: rows.map(rowToContact),
    nextCursor: hasMore && last
      ? Buffer.from(`${(last.last_activity_at as Date).toISOString()}|${last.id}`).toString('base64url')
      : null,
  };
}

/**
 * El contacto del webchat (#46): se enlaza por teléfono (normalizado, el
 * mismo camino de siempre) o, si no lo dio, por correo. Nace origin
 * webchat — escribió primero, así que puede recibir respuestas.
 */
export async function ensureWebContact(
  client: PoolClient,
  input: {
    tenantId: string;
    name?: string;
    phone?: string;
    email?: string;
    requestId?: string;
  },
): Promise<{ contact: Contact; created: boolean }> {
  const email = input.email?.trim().toLowerCase() || undefined;
  if (input.phone?.trim()) {
    const res = await ensureContactByPhone(client, {
      tenantId: input.tenantId,
      phone: input.phone,
      origin: 'webchat',
      requestId: input.requestId,
    });
    if (input.name || email) {
      const contact = await updateContact(client, {
        tenantId: input.tenantId,
        contactId: res.contact.id,
        name: res.contact.name ?? input.name,
        email: res.contact.email ?? email,
        requestId: input.requestId,
      });
      return { contact, created: res.created };
    }
    return res;
  }
  if (!email) throw new Error('Para seguir la conversación dinos tu teléfono o tu correo.');
  const existente = await client.query(
    'SELECT * FROM contacts WHERE tenant_id = $1 AND email = $2 AND phone IS NULL',
    [input.tenantId, email],
  );
  if ((existente.rowCount ?? 0) > 0) {
    return { contact: rowToContact(existente.rows[0]), created: false };
  }
  const r = await client.query(
    `INSERT INTO contacts (tenant_id, phone, name, email, origin)
     VALUES ($1, NULL, $2, $3, 'webchat') RETURNING *`,
    [input.tenantId, input.name ?? null, email],
  );
  const contact = rowToContact(r.rows[0]);
  await publishEvent(client, {
    name: 'contact.created',
    tenantId: input.tenantId,
    payload: { contactId: contact.id, origin: 'webchat' },
    actor: 'system',
    requestId: input.requestId,
  });
  return { contact, created: true };
}
