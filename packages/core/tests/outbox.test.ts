import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { publishEvent } from '../src/events';
import { OutboxDispatcher, type Consumer } from '../src/dispatcher';
import { ModuleRegistry } from '../src/registry';
import type { EventEnvelope } from '../src/events';

/**
 * Los directorios temporales se borran al terminar.
 *
 * Sin esto cada corrida deja uno —esta prueba, varios— y el tmpfs se llena: llegué
 * a 2168 directorios `iaxti-*` y más de 600 MB, y lo que rompió no fue una prueba
 * sino la máquina, a mitad de otra cosa. Una prueba que deja basura es una prueba
 * que a la larga hace fallar a las demás, y el fallo aparece lejísimos de acá.
 */
const temporales: string[] = [];
function registrarTemporal(dir: string): string {
  temporales.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});


const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let registry: ModuleRegistry;

function fixtureRegistry(): ModuleRegistry {
  const dir = registrarTemporal(mkdtempSync(join(tmpdir(), 'iaxti-outbox-')));
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


/**
 * El despachador trabaja sobre TODA la tabla: es un despachador de
 * plataforma, no de un tenant. Así que antes de contar ticks hay que dejar
 * el outbox vacío — si no, lo que cuenta este test es cuántos eventos
 * dejaron pendientes las otras suites, y el número cambia según el orden en
 * que turbo agende los paquetes (issue 207).
 */
async function drenar(): Promise<void> {
  const consumidorMudo: Consumer[] = [];
  const dispatcher = new OutboxDispatcher(admin, registry, consumidorMudo);
  for (let i = 0; i < 50; i++) {
    if ((await dispatcher.tick()) === 0) return;
  }
  throw new Error('el outbox no se vacía: algo lo está llenando en paralelo');
}

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
    await drenar();
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
    await drenar();
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
