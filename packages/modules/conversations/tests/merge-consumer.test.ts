import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import type { EventEnvelope } from '@iaxti/core';
import { onContactMerged } from '../application/merge-consumer';
import { receiveInbound } from '../application/conversations';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('merge-conv') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('consumidor de contact.merged (#34)', () => {
  it('re-apunta las conversaciones del duplicado al principal', async () => {
    const a = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, { tenantId: tenant, phone: '+56951110001', channel: 'simulador', body: 'hola' }),
    );
    const b = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, { tenantId: tenant, phone: '+56951110002', channel: 'simulador', body: 'hola' }),
    );
    const evento: EventEnvelope = {
      id: 1,
      name: 'contact.merged',
      tenantId: tenant,
      payload: { primaryId: a.contact.id, duplicateId: b.contact.id },
      actor: 'sup',
      requestId: randomUUID(),
      version: 1,
      occurredAt: new Date(),
    };
    await withTenant(admin, tenant, (c) => onContactMerged(evento, c));
    const conversaciones = await admin.query(
      'SELECT count(*)::int AS n FROM conversations WHERE tenant_id = $1 AND contact_id = $2',
      [tenant, a.contact.id],
    );
    expect(conversaciones.rows[0].n).toBe(2); // ambas historias bajo el principal
  });
});
