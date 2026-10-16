import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
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
let app: Pool;
let otherTenant: string;
const roleName = `outbox_test_${randomUUID().replaceAll('-', '')}`;

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
  otherTenant = (await admin.query("INSERT INTO tenants (name) VALUES ('test-outbox-rls-other') RETURNING id")).rows[0].id;
  // Identificador generado aquí, nunca entrada del usuario. Rol exclusivo de
  // esta suite: no altera contraseñas ni permisos de la aplicación local.
  await admin.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${roleName}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
  await admin.query(`GRANT SELECT, UPDATE ON outbox TO ${roleName}`);
  await admin.query(`GRANT SELECT, INSERT ON processed_events, idempotency_keys TO ${roleName}`);
  const url = new URL(ADMIN_URL);
  url.username = roleName;
  url.password = roleName;
  app = new Pool({ connectionString: url.toString(), max: 1 });
  expect((await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows)
    .toEqual([{ rolsuper: false, rolbypassrls: false }]);
});

afterAll(async () => {
  await app?.end();
  await admin.query('DELETE FROM processed_events USING outbox WHERE outbox.id = processed_events.event_id AND outbox.tenant_id = ANY($1::uuid[])', [[tenant, otherTenant]]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = ANY($1::uuid[])', [[tenant, otherTenant]]);
  await admin.query('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [[tenant, otherTenant]]);
  await admin.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[tenant, otherTenant]]);
  await admin.query(`DROP OWNED BY ${roleName}`);
  await admin.query(`DROP ROLE ${roleName}`);
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

/** Acota únicamente la selección del arnés; conserva transacciones y RLS reales. */
function isolatedDispatcher(ids: number[], handler: Consumer['handler']): OutboxDispatcher {
  const scoped = {
    connect: async () => {
      const client = await app.connect();
      return new Proxy(client, {
        get(target, key) {
          if (key === 'query') return (sql: string, values?: unknown[]) => {
            if (sql.includes('FROM outbox') && sql.includes('FOR UPDATE SKIP LOCKED')) {
              return target.query(sql.replace('ORDER BY id', 'AND id = ANY($3::bigint[]) ORDER BY id'), [...values!, ids]);
            }
            return target.query(sql, values);
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
  } as Pool;
  return new OutboxDispatcher(scoped, registry, [{
    name: 'audit.rls-regression', moduleId: 'audit', event: 'demo.rls', handler,
  }]);
}

async function rlsEvents(): Promise<number[]> {
  const ids: number[] = [];
  for (const tenantId of [tenant, otherTenant]) {
    const event = await admin.query(
      "INSERT INTO outbox (name, tenant_id, payload, actor) VALUES ('demo.rls', $1, '{}', 'system') RETURNING id",
      [tenantId],
    );
    ids.push(Number(event.rows[0].id));
  }
  return ids;
}

async function writeUnderRls(event: EventEnvelope, client: PoolClient): Promise<void> {
  expect((await client.query("SELECT current_setting('app.tenant_id', true) AS tenant")).rows[0].tenant)
    .toBe(event.tenantId);
  // Consulta sin WHERE de tenant: es PostgreSQL, no un filtro del consumidor,
  // quien impide leer la llave testigo del otro negocio.
  const visible = await client.query('SELECT DISTINCT tenant_id FROM idempotency_keys');
  expect(visible.rows.every(row => row.tenant_id === event.tenantId)).toBe(true);
  await client.query(`INSERT INTO idempotency_keys (tenant_id, key, method, path, request_hash)
    VALUES ($1, $2, 'POST', '/test/outbox', 'test')`, [event.tenantId, `event-${event.id}`]);
}

async function expectNoContext(): Promise<void> {
  // max:1 vuelve a usar la conexión que acaba de devolver el dispatcher.
  expect((await app.query("SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant")).rows)
    .toEqual([{ tenant: null }]);
  expect((await app.query('SELECT tenant_id FROM idempotency_keys')).rowCount).toBe(0);
}

describe('contexto RLS por evento del dispatcher (#922)', () => {
  it('entrega dos tenants con RLS real, limpia el contexto y conserva idempotencia', async () => {
    const ids = await rlsEvents();
    for (const tenantId of [tenant, otherTenant]) {
      await admin.query(`INSERT INTO idempotency_keys (tenant_id, key, method, path, request_hash)
        VALUES ($1, 'testigo', 'POST', '/test', 'test')`, [tenantId]);
    }
    const received: string[] = [];
    const dispatcher = isolatedDispatcher(ids, async (event, client) => {
      await writeUnderRls(event, client);
      received.push(event.tenantId);
    });
    expect(await dispatcher.tick()).toBe(2);
    expect(received).toEqual([tenant, otherTenant]);
    await expectNoContext();
    await admin.query('UPDATE outbox SET processed_at = NULL WHERE id = ANY($1::bigint[])', [ids]);
    expect(await dispatcher.tick()).toBe(2);
    expect(received).toEqual([tenant, otherTenant]);
    expect((await admin.query('SELECT key FROM idempotency_keys WHERE key = ANY($1::text[])', [ids.map(id => `event-${id}`)])).rowCount).toBe(2);
    await expectNoContext();
  });

  it('revierte escritura y claim fallidos, continúa con otro tenant y reintenta sin fugas', async () => {
    const ids = await rlsEvents();
    let fail = true;
    const dispatcher = isolatedDispatcher(ids, async (event, client) => {
      await writeUnderRls(event, client);
      if (event.id === ids[0] && fail) throw new Error('fallo posterior a escritura RLS');
    });
    expect(await dispatcher.tick()).toBe(1);
    expect((await admin.query('SELECT key FROM idempotency_keys WHERE key = ANY($1::text[])', [ids.map(id => `event-${id}`)])).rows)
      .toEqual([{ key: `event-${ids[1]}` }]);
    expect((await admin.query('SELECT event_id::text FROM processed_events WHERE event_id = ANY($1::bigint[])', [ids])).rows)
      .toEqual([{ event_id: String(ids[1]) }]);
    const failed = await admin.query('SELECT attempts, processed_at, last_error FROM outbox WHERE id = $1', [ids[0]]);
    expect(failed.rows[0]).toMatchObject({ attempts: 1, processed_at: null, last_error: 'fallo posterior a escritura RLS' });
    await expectNoContext();
    fail = false;
    expect(await dispatcher.tick()).toBe(1);
    expect((await admin.query('SELECT key FROM idempotency_keys WHERE key = ANY($1::text[])', [ids.map(id => `event-${id}`)])).rowCount).toBe(2);
    await expectNoContext();
  });
});
