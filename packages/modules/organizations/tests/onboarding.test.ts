import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import type { EventEnvelope } from '@iaxti/core';
import { getTenant } from '../application/tenants';
import { onboardingConsumers } from '../application/onboarding';

/**
 * El onboarding avanza solo (SPEC §7). La máquina estaba entera y
 * `advanceOnboarding` no lo llamaba nadie: todos los tenants se quedaban en
 * `registered` para siempre.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

async function emitir(name: string) {
  const consumer = onboardingConsumers().find((c) => c.event === name);
  if (!consumer) throw new Error(`nadie escucha ${name}`);
  const envelope = {
    id: 1,
    name,
    tenantId: tenant,
    payload: {},
    actor: 'system',
    version: 1,
    occurredAt: new Date(),
  } as unknown as EventEnvelope;
  const client = await admin.connect();
  try {
    await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', tenant]);
    await consumer.handler(envelope, client);
  } finally {
    client.release();
  }
}

const estado = () => withTenant(admin, tenant, (c) => getTenant(c, tenant)).then((t) => t.onboardingState);

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('onboarding-test') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

describe('el onboarding avanza con lo que de verdad pasa', () => {
  it('nace en registered y cada evento lo mueve un paso', async () => {
    expect(await estado()).toBe('registered');

    await emitir('tenant.settings_changed');
    expect(await estado()).toBe('configured');

    await emitir('channel.connected');
    expect(await estado()).toBe('whatsapp_connected');

    await emitir('knowledge.source_added');
    expect(await estado()).toBe('knowledge_added');

    await emitir('user.invited');
    expect(await estado()).toBe('team_invited');

    await emitir('message.sent');
    expect(await estado()).toBe('first_message');
  });

  it('un evento que llega tarde no hace retroceder nada', async () => {
    // El orden real no es el del diagrama: un negocio invita a su equipo
    // antes de conectar el número, y los eventos llegan cuando llegan.
    await emitir('tenant.settings_changed');
    await emitir('channel.connected');
    expect(await estado()).toBe('first_message');
  });

  it('repetir un evento no falla ni cambia nada', async () => {
    await emitir('message.sent');
    await emitir('message.sent');
    expect(await estado()).toBe('first_message');
  });
});
