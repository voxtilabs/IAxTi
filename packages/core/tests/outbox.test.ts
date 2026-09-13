import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { publishEvent } from '../src/events';
import { OutboxDispatcher, type Consumer } from '../src/dispatcher';
import { ModuleRegistry } from '../src/registry';
import type { EventEnvelope } from '../src/events';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let registry: ModuleRegistry;

function fixtureRegistry(): ModuleRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'iaxti-outbox-'));
  const mods: Record<string, string> = {
    identity: `module: { id: identity, version: 0.1.0, core: true }\n`,
    organizations: `module: { id: organizations, version: 0.1.0, core: true }\ndepends_on: { required: [identity] }\n`,
    authorization: `module: { id: authorization, version: 0.1.0, core: true }\ndepends_on: { required: [identity, organizations] }\n`,
    audit: `module: { id: audit, version: 0.1.0, core: true }\ndepends_on: { required: [identity, organizations] }\n`,
    calendar: `module: { id: calendar, version: 0.1.0 }\n`,
  };
  for (const [id, yaml] of Object.entries(mods)) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'module.yaml'), yaml);
  }
  return new ModuleRegistry(dir).load();
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-outbox') RETURNING id");
  tenant = t.rows[0].id;
  registry = fixtureRegistry();
});

afterAll(async () => {
  await admin.query('DELETE FROM processed_events USING outbox WHERE outbox.id = processed_events.event_id AND outbox.tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('outbox transaccional', () => {
  it('un evento publicado en una transacción revertida no existe', async () => {
    await expect(
      withTenant(admin, tenant, async (c) => {
        await publishEvent(c, { name: 'demo.fantasma', tenantId: tenant });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const rows = await admin.query("SELECT 1 FROM outbox WHERE name = 'demo.fantasma'");
    expect(rows.rowCount).toBe(0);
  });

  it('entrega una sola vez por consumidor, aunque el tick corra de nuevo', async () => {
    const recibidos: EventEnvelope[] = [];
    const consumers: Consumer[] = [
      {
        name: 'audit.escucha-demo',
        moduleId: 'audit',
        event: 'demo.paso',
        handler: async (e) => {
          recibidos.push(e);
        },
      },
    ];
    await withTenant(admin, tenant, (c) =>
      publishEvent(c, { name: 'demo.paso', tenantId: tenant, payload: { n: 1 }, requestId: 'req_e2e' }),
    );

    const dispatcher = new OutboxDispatcher(admin, registry, consumers);
    expect(await dispatcher.tick()).toBe(1);
    expect(await dispatcher.tick()).toBe(0); // nada pendiente
    expect(recibidos).toHaveLength(1);
    expect(recibidos[0].payload).toEqual({ n: 1 });
    expect(recibidos[0].tenantId).toBe(tenant);
    expect(recibidos[0].requestId).toBe('req_e2e');
  });

  it('el consumidor de un módulo apagado se salta sin marcar entrega', async () => {
    const recibidos: string[] = [];
    const consumers: Consumer[] = [
      { name: 'calendar.escucha', moduleId: 'calendar', event: 'demo.cita', handler: async () => { recibidos.push('x'); } },
    ];
    registry.disable('calendar');
    await withTenant(admin, tenant, (c) => publishEvent(c, { name: 'demo.cita', tenantId: tenant }));

    const dispatcher = new OutboxDispatcher(admin, registry, consumers);
    await dispatcher.tick();
    expect(recibidos).toHaveLength(0);
    registry.enable('calendar');
  });

  it('un handler que falla reintenta en el siguiente tick y registra el error', async () => {
    let intentos = 0;
    const consumers: Consumer[] = [
      {
        name: 'audit.fragil',
        moduleId: 'audit',
        event: 'demo.fragil',
        handler: async () => {
          intentos += 1;
          if (intentos === 1) throw new Error('falla transitoria');
        },
      },
    ];
    await withTenant(admin, tenant, (c) => publishEvent(c, { name: 'demo.fragil', tenantId: tenant }));

    const dispatcher = new OutboxDispatcher(admin, registry, consumers);
    expect(await dispatcher.tick()).toBe(0); // falló: no procesado
    const conError = await admin.query(
      "SELECT attempts, last_error FROM outbox WHERE name = 'demo.fragil' AND tenant_id = $1",
      [tenant],
    );
    expect(conError.rows[0].attempts).toBe(1);
    expect(conError.rows[0].last_error).toMatch(/falla transitoria/);

    expect(await dispatcher.tick()).toBe(1); // reintento exitoso
    expect(intentos).toBe(2);
  });
});
