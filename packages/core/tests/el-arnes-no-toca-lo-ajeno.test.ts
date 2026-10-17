import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { publishEvent } from '../src/events';
import { OutboxDispatcher } from '../src/dispatcher';
import { ModuleRegistry } from '../src/registry';
import { outboxAcotado } from '../src/testing/outbox-acotado';

/**
 * El arnés del outbox no toca los eventos de las demás pruebas (#972).
 *
 * `tick()` barre la tabla entera, así que una prueba que quiera contar ticks
 * tiene que acotarlo de alguna forma. La primera salida fue VACIARLO —un
 * despachador con la lista de consumidores vacía, que marca todo como
 * procesado—, y eso tiene un costo que no se ve en la prueba que lo hace: los
 * eventos pendientes de las otras suites que corren en paralelo quedan
 * consumidos por nadie. La prueba que los publicó falla, en otro archivo, por
 * algo que no hizo.
 *
 * Esta guarda fija la propiedad que hace seguro el reemplazo: después de usar
 * `outboxAcotado`, lo ajeno sigue pendiente.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let mio: string;
let ajeno: string;
let registry: ModuleRegistry;
const temporales: string[] = [];

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const dir = mkdtempSync(join(tmpdir(), 'iaxti-arnes-'));
  temporales.push(dir);
  mkdirSync(join(dir, 'audit'));
  writeFileSync(join(dir, 'audit', 'module.yaml'), 'module: { id: audit, version: 0.1.0, core: true }\n');
  registry = new ModuleRegistry(dir).load();
  mio = (await admin.query("INSERT INTO tenants (name) VALUES ('arnes-mio') RETURNING id")).rows[0].id;
  ajeno = (await admin.query("INSERT INTO tenants (name) VALUES ('arnes-ajeno') RETURNING id")).rows[0].id;
});

afterAll(async () => {
  await admin.query(
    `DELETE FROM processed_events USING outbox
      WHERE outbox.id = processed_events.event_id AND outbox.tenant_id = ANY($1::uuid[])`,
    [[mio, ajeno]],
  );
  await admin.query('DELETE FROM outbox WHERE tenant_id = ANY($1::uuid[])', [[mio, ajeno]]);
  await admin.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[mio, ajeno]]);
  await admin.end();
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});

const publicar = (tenantId: string, name: string): Promise<number> =>
  withTenant(admin, tenantId, async (c) => {
    await publishEvent(c, { name, tenantId, payload: {}, actor: 'prueba' });
    const r = await c.query(
      'SELECT id FROM outbox WHERE tenant_id = $1 AND name = $2 ORDER BY id DESC LIMIT 1',
      [tenantId, name],
    );
    return Number(r.rows[0].id);
  });

const procesado = async (id: number) =>
  (await admin.query('SELECT processed_at FROM outbox WHERE id = $1', [id])).rows[0].processed_at;

describe('outboxAcotado', () => {
  it('procesa lo propio y deja pendiente lo ajeno', async () => {
    // El de otra suite se publica PRIMERO: es el más viejo, así que un
    // despachador sin acotar lo tomaría a él antes que al nuestro.
    const deOtraPrueba = await publicar(ajeno, 'demo.de-otra-suite');
    const nuestro = await publicar(mio, 'demo.nuestro');

    const n = await new OutboxDispatcher(outboxAcotado(admin, [nuestro]), registry, []).tick();

    expect(n).toBe(1);
    expect(await procesado(nuestro)).not.toBeNull();
    // Lo que esta guarda existe para fijar.
    expect(await procesado(deOtraPrueba)).toBeNull();
  });

  it('acota a varios ids a la vez, y nada más', async () => {
    const uno = await publicar(mio, 'demo.uno');
    const dos = await publicar(mio, 'demo.dos');
    const fuera = await publicar(ajeno, 'demo.fuera');

    const n = await new OutboxDispatcher(outboxAcotado(admin, [uno, dos]), registry, []).tick();

    expect(n).toBe(2);
    expect(await procesado(fuera)).toBeNull();
  });

  it('el pool envuelto sirve para consultar como cualquier otro', async () => {
    // `pool.query()` de `pg` usa la forma de CALLBACK de `connect`. Una
    // envoltura que solo devuelva promesa lo deja esperando a nadie, y el
    // síntoma es una prueba colgada sin mensaje (#913).
    const envuelto = outboxAcotado(admin, []);
    const r = await envuelto.query('SELECT 1 AS n');
    expect(r.rows[0].n).toBe(1);
  });
});
