import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { publishEvent, type EventEnvelope } from '../src/events';
import { OutboxDispatcher, type Consumer } from '../src/dispatcher';
import { ModuleRegistry } from '../src/registry';
import { outboxAcotado } from '../src/testing/outbox-acotado';

/**
 * El sobre trae su tenant, y el despachador tiene que fijarlo (#922).
 *
 * `tick()` abre una transacción, lee el lote y llama a cada consumidor con ESE
 * cliente, sin fijar `app.tenant_id`. Todo consumidor que escribe en una tabla
 * con RLS lo hacía sin contexto: con el rol de desarrollo —superusuario—
 * Postgres ni evalúa las políticas y todo pasa; con el rol que exige #370 los
 * eventos agotan sus cinco intentos y el tablero del dueño se queda sin
 * números, sin que nadie vea un error.
 *
 * Por eso estas pruebas corren con un rol NOSUPERUSER NOBYPASSRLS. Con el de
 * siempre no podrían fallar, que es como el defecto llegó hasta acá.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ROL = 'iaxti_sobre_922';
const APP_URL = ADMIN_URL.replace(/\/\/[^:]+:[^@]+@/, `//${ROL}:${ROL}@`);

let admin: Pool;
let app: Pool;
let tenantA: string;
let tenantB: string;
let registry: ModuleRegistry;
const temporales: string[] = [];

function fixtureRegistry(): ModuleRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'iaxti-sobre-'));
  temporales.push(dir);
  mkdirSync(join(dir, 'crm'));
  writeFileSync(join(dir, 'crm', 'module.yaml'), 'module: { id: crm, version: 0.1.0 }\n');
  return new ModuleRegistry(dir).load();
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROL}') THEN
      CREATE ROLE ${ROL} LOGIN PASSWORD '${ROL}';
    END IF;
  END $$;`);
  await admin.query(`ALTER ROLE ${ROL} NOSUPERUSER NOBYPASSRLS PASSWORD '${ROL}'`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROL}`);
  // Lo justo que toca el despachador: la cola, el registro de entregas y la
  // tabla con RLS donde escribe el consumidor de la prueba.
  await admin.query(`GRANT SELECT, UPDATE ON outbox TO ${ROL}`);
  await admin.query(`GRANT SELECT, INSERT ON processed_events TO ${ROL}`);
  await admin.query(`GRANT SELECT, INSERT ON contacts TO ${ROL}`);
  app = createPool(APP_URL);
  registry = fixtureRegistry();

  tenantA = (await admin.query("INSERT INTO tenants (name) VALUES ('sobre-922-a') RETURNING id"))
    .rows[0].id;
  tenantB = (await admin.query("INSERT INTO tenants (name) VALUES ('sobre-922-b') RETURNING id"))
    .rows[0].id;
});

const DE_LAS_PRUEBAS = [] as string[];

async function limpiar() {
  await admin.query('DELETE FROM contacts WHERE tenant_id = ANY($1)', [[tenantA, tenantB]]);
  await admin.query(
    `DELETE FROM processed_events USING outbox
      WHERE outbox.id = processed_events.event_id AND outbox.tenant_id = ANY($1)`,
    [[tenantA, tenantB]],
  );
  await admin.query('DELETE FROM outbox WHERE tenant_id = ANY($1)', [[tenantA, tenantB]]);
}

afterEach(limpiar);

afterAll(async () => {
  await limpiar();
  await app.end();
  await admin.query(`REVOKE ALL ON outbox, processed_events, contacts FROM ${ROL}`).catch(() => undefined);
  await admin.query(`REVOKE USAGE ON SCHEMA public FROM ${ROL}`).catch(() => undefined);
  await admin.query('DELETE FROM tenants WHERE id = ANY($1)', [[tenantA, tenantB]]).catch(() => undefined);
  await admin.query(`DROP ROLE IF EXISTS ${ROL}`).catch(() => undefined);
  await admin.end();
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
  void DE_LAS_PRUEBAS;
});

/** Lo que vio cada consumidor cuando le tocó correr. */
interface Visto {
  tenant: string;
  contexto: string | null;
  vecinos: number;
}

/**
 * Un consumidor que hace lo que hacen los de verdad: escribir en una tabla con
 * RLS. Si se le dice, se cae DESPUÉS de escribir, que es el caso que prueba
 * que el savepoint deshace su escritura y no solo su marca de entrega.
 */
function consumidorQueEscribe(explotaEn?: string) {
  const visto: Visto[] = [];
  const consumer: Consumer = {
    name: 'prueba.922.escribe',
    moduleId: 'crm',
    event: 'contact.created',
    async handler(event: EventEnvelope, client: PoolClient) {
      const ctx = await client.query("SELECT current_setting('app.tenant_id', true) AS t");
      // Lo que ve de la tabla ajena: con el contexto puesto, RLS lo deja en
      // cero aunque el otro negocio tenga filas.
      const otros = await client.query('SELECT count(*)::int AS n FROM contacts WHERE tenant_id <> $1', [
        event.tenantId,
      ]);
      visto.push({
        tenant: event.tenantId,
        contexto: ctx.rows[0].t || null,
        vecinos: otros.rows[0].n,
      });
      await client.query(
        `INSERT INTO contacts (tenant_id, name, phone, origin)
         VALUES ($1, $2, $3, 'manual')`,
        [event.tenantId, `Del evento ${event.id}`, `+56977${String(event.id).padStart(6, '0').slice(-6)}`],
      );
      if (explotaEn === event.tenantId) throw new Error('este consumidor se cae');
    },
  };
  return { consumer, visto };
}

/**
 * El outbox es de TODOS: `tick()` toma los 50 eventos pendientes más viejos de
 * la base, sin mirar de quién son. En la base compartida de las pruebas eso
 * significa dos cosas, y las dos arruinan una prueba que no lo sepa: los
 * eventos de esta prueba pueden quedar fuera del lote, y el `tick` puede
 * devolver 50 cuando acá se publicó uno.
 *
 * La primera versión lo resolvía VACIANDO el outbox antes de cada caso. Ya no:
 * vaciar marca como procesados los pendientes de las demás pruebas que corren
 * en paralelo, y el rojo aparece en otro archivo. `outboxAcotado` acota el
 * `SELECT` del despachador a estos ids y no toca lo ajeno (#972, idea de
 * #939).
 */
const despachador = (ids: number[], consumer: Consumer) =>
  new OutboxDispatcher(outboxAcotado(app, ids), registry, [consumer]);

/** Publica por el camino de verdad y devuelve el id, que es lo que acota. */
const publicar = (tenantId: string): Promise<number> =>
  withTenant(admin, tenantId, async (c) => {
    await publishEvent(c, { name: 'contact.created', tenantId, payload: {}, actor: 'prueba' });
    const r = await c.query(
      "SELECT id FROM outbox WHERE tenant_id = $1 AND name = 'contact.created' ORDER BY id DESC LIMIT 1",
      [tenantId],
    );
    return Number(r.rows[0].id);
  });

const contactosDe = async (t: string) =>
  Number((await admin.query('SELECT count(*) FROM contacts WHERE tenant_id = $1', [t])).rows[0].count);

const sobreDe = async (t: string) =>
  (await admin.query('SELECT processed_at, attempts, last_error FROM outbox WHERE tenant_id = $1', [t]))
    .rows[0];

describe('el despachador fija el tenant del sobre (#922)', () => {
  it('un consumidor escribe en una tabla con RLS bajo un rol que SÍ las evalúa', async () => {
    const id = await publicar(tenantA);
    const { consumer } = consumidorQueEscribe();

    const n = await despachador([id], consumer).tick();

    expect(n).toBe(1);
    expect(await contactosDe(tenantA)).toBe(1);
    const sobre = await sobreDe(tenantA);
    expect(sobre.last_error).toBeNull();
    expect(sobre.processed_at).not.toBeNull();
  });

  it('un lote de dos negocios le da a cada consumidor SU contexto, y nada del otro', async () => {
    const ids = [await publicar(tenantA), await publicar(tenantB)];
    const { consumer, visto } = consumidorQueEscribe();

    const n = await despachador(ids, consumer).tick();

    expect(n).toBe(2);
    // Lo que importa no es que haya contexto: es que sea el del sobre. Un
    // despachador que fijara el primero y siguiera igual pasaría la de arriba
    // y rompería ésta.
    expect(visto.map((v) => v.contexto)).toEqual(visto.map((v) => v.tenant));
    expect(new Set(visto.map((v) => v.tenant))).toEqual(new Set([tenantA, tenantB]));
    // El segundo corre cuando el primero ya escribió su contacto, así que si
    // el contexto no acotara, acá habría un vecino a la vista.
    expect(visto.map((v) => v.vecinos)).toEqual([0, 0]);
    expect(await contactosDe(tenantA)).toBe(1);
    expect(await contactosDe(tenantB)).toBe(1);
  });

  it('si un consumidor falla, su escritura y su entrega se deshacen, y el siguiente sigue con lo suyo', async () => {
    const ids = [await publicar(tenantA), await publicar(tenantB)];
    const { consumer, visto } = consumidorQueEscribe(tenantA);

    await despachador(ids, consumer).tick();

    expect(await contactosDe(tenantA)).toBe(0);
    const fallado = await sobreDe(tenantA);
    expect(fallado.attempts).toBe(1);
    expect(fallado.processed_at).toBeNull();
    expect(fallado.last_error).toContain('se cae');
    const entregas = await admin.query(
      `SELECT 1 FROM processed_events pe JOIN outbox o ON o.id = pe.event_id WHERE o.tenant_id = $1`,
      [tenantA],
    );
    expect(entregas.rowCount).toBe(0);
    // Y el siguiente no hereda nada del que se cayó: ni el contexto ni el
    // estado. El `ROLLBACK TO SAVEPOINT` también deshace el `set_config`.
    expect(await contactosDe(tenantB)).toBe(1);
    expect(visto.find((v) => v.tenant === tenantB)?.contexto).toBe(tenantB);
  });

  it('el contexto no queda pegado en la conexión que vuelve al pool', async () => {
    const id = await publicar(tenantA);
    const { consumer } = consumidorQueEscribe();
    await despachador([id], consumer).tick();

    // El pool es de uno: la conexión que acaba de despachar es la misma que
    // va a atender lo próximo. Si el `set_config` no fuera local a la
    // transacción, lo próximo correría con el tenant del último evento.
    const c = await app.connect();
    try {
      const r = await c.query("SELECT current_setting('app.tenant_id', true) AS t");
      expect(r.rows[0].t === null || r.rows[0].t === '').toBe(true);
    } finally {
      c.release();
    }
  });

  it('tras un consumidor que falla tampoco queda pegado', async () => {
    const id = await publicar(tenantA);
    const { consumer } = consumidorQueEscribe(tenantA);
    await despachador([id], consumer).tick();

    const c = await app.connect();
    try {
      const r = await c.query("SELECT current_setting('app.tenant_id', true) AS t");
      expect(r.rows[0].t === null || r.rows[0].t === '').toBe(true);
    } finally {
      c.release();
    }
  });

  it('la reentrega de un evento ya reclamado sigue sin repetirse', async () => {
    const id = await publicar(tenantA);
    const { consumer } = consumidorQueEscribe();
    const dispatcher = despachador([id], consumer);

    await dispatcher.tick();
    const otra = await dispatcher.tick();

    expect(otra).toBe(0);
    expect(await contactosDe(tenantA)).toBe(1);
  });
});
