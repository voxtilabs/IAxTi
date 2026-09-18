import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createPool } from '../src/client';
import { runMigrations } from '../src/migrate';
import { withTenant } from '../src/tenant';

/**
 * Los barridos programados con el rol de la aplicación, no con el de
 * desarrollo.
 *
 * Casi todos los barridos empiezan igual: una consulta SUELTA al pool para
 * saber qué tenants tienen trabajo.
 *
 *     SELECT DISTINCT tenant_id FROM appointments WHERE starts_at ...
 *     SELECT tenant_id, id FROM invoices WHERE status = 'issued' ...
 *
 * Una consulta suelta no pasa por `withTenant`, así que corre **sin**
 * `app.tenant_id` — el `set_config(..., true)` es local a la transacción y
 * no deja residuo. Con RLS FORCE, la política evalúa `tenant_id = NULL` y
 * devuelve **cero filas**.
 *
 * En desarrollo no se nota: el rol `iaxti` es superusuario y Postgres ni
 * mira las políticas. En producción el rol NO puede serlo —lo exige el
 * runbook y la aplicación se niega a servir si lo es (#227)—, y entonces
 * cada barrido ve un mundo vacío. Sin error: cero filas es idéntico a "no
 * hay nada que hacer".
 *
 * Este test corre con un rol sin privilegios, como el de producción.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenant: string;

/** Las tablas que los barridos programados recorren de lado a lado. */
const TABLAS_DE_BARRIDO = [
  'appointments',
  'invoices',
  'subscriptions',
  'whatsapp_templates',
  'conversations',
  'webhook_endpoints',
  'sequence_enrollments',
];

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
        CREATE ROLE iaxti_app LOGIN PASSWORD 'iaxti_app';
      END IF;
    END $$
  `);
  await admin.query('GRANT USAGE ON SCHEMA public TO iaxti_app');
  await admin.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));

  const t = await admin.query("INSERT INTO tenants (name) VALUES ('barridos-rol-real') RETURNING id");
  tenant = t.rows[0].id;
  const c = await admin.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin)
     VALUES ($1, 'Ana', '+56900000777', 'whatsapp') RETURNING id`,
    [tenant],
  );
  await admin.query(
    `INSERT INTO appointments (tenant_id, contact_id, owner_id, starts_at, ends_at, status)
     VALUES ($1, $2, gen_random_uuid(), now() + interval '23 hours 30 minutes',
             now() + interval '24 hours 30 minutes', 'confirmed')`,
    [tenant, c.rows[0].id],
  );
});

afterAll(async () => {
  await app.end();
  await admin.end();
});

describe('el rol de la aplicación y los barridos', () => {
  it('con el rol de desarrollo la consulta cross-tenant ve la cita', async () => {
    // El punto de comparación: así se ve todo mientras `iaxti` sea
    // superusuario. Es lo que ve la suite entera, y por eso nadie lo notó.
    const r = await admin.query(
      `SELECT count(*)::int AS n FROM appointments
        WHERE status IN ('confirmed','reminded') AND starts_at > now()`,
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  it('con el rol de producción NO la ve: el barrido corre sobre un mundo vacío', async () => {
    const r = await app.query(
      `SELECT count(*)::int AS n FROM appointments
        WHERE status IN ('confirmed','reminded') AND starts_at > now()`,
    );
    // Esto NO es un fallo del test: es el comportamiento correcto de RLS y
    // el problema del diseño del barrido. Se deja escrito para que quede
    // claro qué es lo que está mal —la consulta suelta, no la política.
    expect(r.rows[0].n).toBe(0);
  });

  it('dentro de withTenant sí la ve: el camino correcto funciona', async () => {
    const n = await withTenant(app, tenant, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM appointments
          WHERE status IN ('confirmed','reminded') AND starts_at > now()`,
      );
      return r.rows[0].n as number;
    });
    expect(n).toBeGreaterThan(0);
  });

  it('`tenants` se lee sin contexto a propósito: es por donde empieza todo', async () => {
    // La tabla de tenants NO tiene RLS, y está bien: es el registro de
    // quiénes existen. Un barrido correcto arranca acá y entra a cada uno
    // con withTenant.
    const r = await app.query('SELECT count(*)::int AS n FROM tenants');
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  it('todas las tablas de barrido tienen RLS FORCE: ninguna es la excepción', async () => {
    const r = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)`,
      [TABLAS_DE_BARRIDO],
    );
    expect(r.rowCount).toBe(TABLAS_DE_BARRIDO.length);
    for (const fila of r.rows) {
      // Si alguna dejara de tener RLS, los barridos "funcionarían" — y sería
      // por la peor razón posible.
      expect(fila.relrowsecurity, `${fila.relname} sin RLS`).toBe(true);
      expect(fila.relforcerowsecurity, `${fila.relname} sin FORCE`).toBe(true);
    }
  });
});

describe('ningún barrido consulta una tabla con RLS fuera de withTenant', () => {
  it('las consultas sueltas al pool solo tocan tablas sin RLS', async () => {
    const raiz = join(__dirname, '../../..');
    const conRls = new Set(
      (
        await admin.query(
          `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`,
        )
      ).rows.map((x) => x.relname as string),
    );

    /**
     * Excepciones con su motivo, como el resto de las listas del proyecto.
     * El módulo `platform` es cross-tenant a propósito: es el panel del
     * SuperAdmin, y en producción se conecta con otro rol.
     */
    const A_PROPOSITO = ['packages/modules/platform/'];

    const sospechosas: string[] = [];
    const recorrer = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.next', '.turbo', '.git'].includes(e.name)) continue;
        const ruta = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'tests') continue;
          recorrer(ruta);
          continue;
        }
        if (!e.name.endsWith('.ts') || e.name.includes('.test.')) continue;
        const rel = ruta.slice(raiz.length + 1);
        if (A_PROPOSITO.some((p) => rel.startsWith(p))) continue;

        const texto = readFileSync(ruta, 'utf8');
        // `pool.query(` y lo que venga hasta el cierre del template: basta
        // para ver de qué tabla lee.
        for (const m of texto.matchAll(/pool\.query\(\s*`([^`]*)`/g)) {
          for (const t of m[1].matchAll(/\bFROM\s+([a-z_]+)/gi)) {
            if (conRls.has(t[1])) sospechosas.push(`${rel}: SELECT ... FROM ${t[1]}`);
          }
        }
      }
    };
    recorrer(join(raiz, 'packages'));
    recorrer(join(raiz, 'apps'));

    expect(
      sospechosas,
      'Una consulta suelta al pool corre sin `app.tenant_id`: con el rol de\n' +
        'producción devuelve CERO filas, sin error. Sácala de ahí con\n' +
        '`porCadaTenant`, o empieza por `tenants`, que no tiene RLS:\n  ' +
        sospechosas.join('\n  '),
    ).toEqual([]);
  });
});

describe('resolver una API key con el rol de producción (#286)', () => {
  it('funciona: es un paso ANTERIOR a saber el tenant', async () => {
    const hash = 'hash-de-prueba-286';
    await admin.query(
      `INSERT INTO api_keys (tenant_id, name, key_hash, scopes)
       VALUES ($1, 'de prueba', $2, '["crm.contacts.read"]'::jsonb)`,
      [tenant, hash],
    );
    await admin.query('GRANT EXECUTE ON FUNCTION resolver_api_key(text) TO iaxti_app');

    // Directo a la tabla, el rol de producción no ve nada — que es lo
    // correcto y lo que rompía la autenticación por API key.
    const directo = await app.query('SELECT count(*)::int AS n FROM api_keys WHERE key_hash = $1', [
      hash,
    ]);
    expect(directo.rows[0].n).toBe(0);

    // Por la función acotada, sí.
    const r = await app.query('SELECT * FROM resolver_api_key($1)', [hash]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].tenant_id).toBe(tenant);
    expect(r.rows[0].scopes).toEqual(['crm.contacts.read']);
  });

  it('sin el hash no devuelve nada: no sirve para recorrer la tabla', async () => {
    const r = await app.query('SELECT * FROM resolver_api_key($1)', ['cualquier-cosa']);
    expect(r.rowCount).toBe(0);
  });

  it('una key revocada no resuelve', async () => {
    const hash = 'hash-revocado-286';
    await admin.query(
      `INSERT INTO api_keys (tenant_id, name, key_hash, scopes, revoked_at)
       VALUES ($1, 'revocada', $2, '[]'::jsonb, now())`,
      [tenant, hash],
    );
    const r = await app.query('SELECT * FROM resolver_api_key($1)', [hash]);
    expect(r.rowCount).toBe(0);
  });
});
