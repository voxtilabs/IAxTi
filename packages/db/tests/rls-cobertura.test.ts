import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/client';
import { runMigrations } from '../src/migrate';

/**
 * El invariante que sostiene el producto entero: **toda tabla con
 * `tenant_id` aísla por RLS**.
 *
 * El otro test de RLS prueba que el MECANISMO funciona, sobre una tabla de
 * demo. Este prueba algo distinto y más frágil: que no se nos quede ninguna
 * tabla afuera. Se agregan tablas todas las semanas —hoy mismo entraron
 * `contact_identities` y `push_subscriptions`— y una sin política no falla
 * en ningún test: simplemente le muestra los datos de un cliente a otro.
 *
 * `FORCE` además de `ENABLE` porque sin FORCE el DUEÑO de la tabla se salta
 * la política, y en producción la app se conecta con un rol que es dueño.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

/**
 * Tablas de plataforma que cruzan tenants A PROPÓSITO. Cada una con su
 * motivo escrito: la lista existe para distinguir "es deliberado" de "se le
 * olvidó a alguien", que es justo lo que no se podía distinguir antes.
 */
const CROSS_TENANT: Record<string, string> = {
  outbox:
    'El despachador la lee cross-tenant con el rol de workers; el rol de aplicación solo INSERTa (packages/db/migrations/0001_outbox.sql).',
  platform_support_sessions:
    'Sesiones de soporte del SuperAdmin: existen para mirar OTROS tenants, y el acceso lo controla el permiso platform.tenants (#68).',
};

let admin: Pool;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
});

afterAll(async () => {
  await admin.end();
});

describe('cobertura de RLS', () => {
  it('toda tabla con tenant_id tiene RLS, FORCE y su política', async () => {
    const r = await admin.query(`
      SELECT c.relname AS tabla,
             c.relrowsecurity AS habilitada,
             c.relforcerowsecurity AS forzada,
             (SELECT count(*)::int FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS politicas
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM information_schema.columns col
                      WHERE col.table_schema = 'public'
                        AND col.table_name = c.relname
                        AND col.column_name = 'tenant_id')
       ORDER BY 1`);

    // Que el test esté mirando algo: si un cambio de esquema dejara la
    // consulta en cero, este test pasaría sin verificar nada.
    expect(r.rows.length).toBeGreaterThan(20);

    const desprotegidas = r.rows
      .filter((t) => !(t.tabla in CROSS_TENANT))
      .filter((t) => !t.habilitada || !t.forzada || t.politicas === 0)
      .map((t) =>
        `${t.tabla} (enable=${t.habilitada}, force=${t.forzada}, políticas=${t.politicas})`,
      );

    expect(
      desprotegidas,
      `Estas tablas tienen tenant_id y NO aíslan por RLS:\n  ${desprotegidas.join('\n  ')}\n` +
        'Cada una le muestra los datos de un cliente a otro. Si el cruce es deliberado, ' +
        'agrégala a CROSS_TENANT con el motivo; si no, ponle ENABLE + FORCE + política.',
    ).toEqual([]);
  });

  it('la lista de excepciones no junta polvo', async () => {
    // Una excepción que ya no existe es una excepción que nadie revisó.
    const r = await admin.query(
      `SELECT c.relname AS tabla FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
      [Object.keys(CROSS_TENANT)],
    );
    expect(r.rows.map((t) => t.tabla).sort()).toEqual(Object.keys(CROSS_TENANT).sort());

    // Y cada una con su motivo de verdad, no con un "TODO".
    for (const [tabla, motivo] of Object.entries(CROSS_TENANT)) {
      expect(motivo.length, `${tabla} necesita un motivo escrito`).toBeGreaterThan(40);
    }
  });
});
