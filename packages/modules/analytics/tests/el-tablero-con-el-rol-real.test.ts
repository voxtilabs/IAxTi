import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { ModuleRegistry, OutboxDispatcher, publishEvent } from '@iaxti/core';
import { outboxAcotado } from '@iaxti/core/testing';
import { analyticsConsumers } from '../application/aggregate';
import { TOTAL_OWNER } from '../domain/metrics';

/**
 * El consumidor de verdad, por el camino de verdad, con el rol de verdad
 * (#922).
 *
 * `packages/core` prueba que el despachador fija el contexto; esto prueba que
 * con eso el tablero del dueño se llena. Es la reproducción del issue tal cual
 * se reportó: 24 eventos agotando sus cinco intentos con
 * «new row violates row-level security policy for table "daily_metrics"»,
 * porque `bump` escribe en una tabla con FORCE RLS y el despachador la llamaba
 * sin tenant en la sesión.
 *
 * Tiene que correr con un rol NOSUPERUSER NOBYPASSRLS: con el de desarrollo,
 * que es superusuario, Postgres ni evalúa las políticas y esta prueba pasaría
 * con el defecto puesto. Es la lección de #370 y de #286.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ROL = 'iaxti_tablero_922';
const APP_URL = ADMIN_URL.replace(/\/\/[^:]+:[^@]+@/, `//${ROL}:${ROL}@`);

let admin: Pool;
let app: Pool;
let tenantA: string;
let tenantB: string;
let registry: ModuleRegistry;
const temporales: string[] = [];

function registroConAnalytics(): ModuleRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'iaxti-tablero-'));
  temporales.push(dir);
  mkdirSync(join(dir, 'analytics'));
  writeFileSync(join(dir, 'analytics', 'module.yaml'), 'module: { id: analytics, version: 0.1.0 }\n');
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
  await admin.query(`GRANT SELECT, UPDATE ON outbox TO ${ROL}`);
  await admin.query(`GRANT SELECT, INSERT ON processed_events TO ${ROL}`);
  // Lo que `bump` necesita: inserta o suma sobre la misma fila del día.
  await admin.query(`GRANT SELECT, INSERT, UPDATE ON daily_metrics TO ${ROL}`);
  // Y la zona del negocio, que el consumidor lee antes de contar: el día se
  // cierra en la zona del tenant, no en la del servidor. Sin este permiso el
  // evento falla con «current transaction is aborted» —ver #962— que no dice
  // nada de lo que esta prueba vigila.
  await admin.query(`GRANT SELECT ON tenants TO ${ROL}`);
  app = createPool(APP_URL);
  registry = registroConAnalytics();

  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.query('INSERT INTO tenants (id, name) VALUES ($1, $3), ($2, $3)', [
    tenantA,
    tenantB,
    'tablero-922',
  ]);
});

async function limpiar() {
  await admin.query('DELETE FROM daily_metrics WHERE tenant_id = ANY($1::uuid[])', [[tenantA, tenantB]]);
  await admin.query(
    `DELETE FROM processed_events USING outbox
      WHERE outbox.id = processed_events.event_id AND outbox.tenant_id = ANY($1::uuid[])`,
    [[tenantA, tenantB]],
  );
  await admin.query('DELETE FROM outbox WHERE tenant_id = ANY($1::uuid[])', [[tenantA, tenantB]]);
}

afterEach(limpiar);

afterAll(async () => {
  await limpiar();
  await app.end();
  await admin.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[tenantA, tenantB]]);
  await admin.query(`REVOKE ALL ON outbox, processed_events, daily_metrics, tenants FROM ${ROL}`).catch(() => undefined);
  await admin.query(`REVOKE USAGE ON SCHEMA public FROM ${ROL}`).catch(() => undefined);
  await admin.query(`DROP ROLE IF EXISTS ${ROL}`).catch(() => undefined);
  await admin.end();
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});

/**
 * El outbox es de TODOS: `tick()` toma los 50 pendientes más viejos de la
 * base, sin mirar de quién son. En la base compartida de las pruebas, los
 * eventos de acá pueden quedar fuera del lote y el `tick` devolver el conteo
 * de los ajenos.
 *
 * Se acota a los ids de esta prueba en vez de vaciar el outbox: vaciarlo
 * marca como procesados los pendientes de las demás suites que corren en
 * paralelo, y el rojo sale en otro archivo (#972, idea de #939).
 */
const despachador = (ids: number[]) =>
  new OutboxDispatcher(outboxAcotado(app, ids), registry, analyticsConsumers());

/** Publica por el camino de verdad y devuelve el id, que es lo que acota. */
const publicar = (tenantId: string, name: string): Promise<number> =>
  withTenant(admin, tenantId, async (c) => {
    await publishEvent(c, { name, tenantId, payload: {}, actor: 'prueba' });
    const r = await c.query(
      'SELECT id FROM outbox WHERE tenant_id = $1 AND name = $2 ORDER BY id DESC LIMIT 1',
      [tenantId, name],
    );
    return Number(r.rows[0].id);
  });

const totalDe = async (tenantId: string, metric: string) =>
  Number(
    (
      await admin.query(
        `SELECT COALESCE(sum(value), 0) AS v FROM daily_metrics
          WHERE tenant_id = $1 AND metric = $2 AND owner_id = $3`,
        [tenantId, metric, TOTAL_OWNER],
      )
    ).rows[0].v,
  );

describe('el tablero del dueño se llena con el rol de producción (#922)', () => {
  it('una conversación nueva suma su contador, en vez de agotar los cinco intentos', async () => {
    const id = await publicar(tenantA, 'conversation.created');

    const n = await despachador([id]).tick();

    expect(n).toBe(1);
    expect(await totalDe(tenantA, 'conversaciones_nuevas')).toBe(1);
    const sobre = (
      await admin.query('SELECT processed_at, attempts, last_error FROM outbox WHERE tenant_id = $1', [
        tenantA,
      ])
    ).rows[0];
    // Lo que reportaba el issue: `last_error` con la violación de la política
    // y el evento sin procesar hasta agotarse.
    expect(sobre.last_error).toBeNull();
    expect(sobre.processed_at).not.toBeNull();
  });

  it('en un lote de dos negocios, cada contador queda en el suyo', async () => {
    const ids = [
      await publicar(tenantA, 'conversation.created'),
      await publicar(tenantB, 'conversation.created'),
      await publicar(tenantB, 'deal.won'),
    ];

    const n = await despachador(ids).tick();

    expect(n).toBe(3);
    expect(await totalDe(tenantA, 'conversaciones_nuevas')).toBe(1);
    expect(await totalDe(tenantB, 'conversaciones_nuevas')).toBe(1);
    expect(await totalDe(tenantB, 'ganadas')).toBe(1);
    // Y ninguno se contó en la cuenta del vecino.
    expect(await totalDe(tenantA, 'ganadas')).toBe(0);
  });
});
