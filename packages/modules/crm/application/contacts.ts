import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { isOptOutMessage, normalizePhone, normalizeRut } from '../domain/validation';

export type ContactOrigin = 'whatsapp' | 'webchat' | 'importado' | 'manual';

export interface Contact {
  id: string;
  tenantId: string;
  phone: string;
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
    phone: row.phone as string,
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
    return { contact: rowToContact(existing.rows[0]), created: false };
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
