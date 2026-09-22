import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/client';
import { runMigrations } from '../src/migrate';
import { blindarEsquema } from '../src/blindaje';

/**
 * Que la API de datos de Supabase no vea nada nuestro (#456).
 *
 * Supabase publica TODO el esquema `public` por PostgREST con la llave
 * anónima que viaja en el navegador, y sus privilegios por defecto alcanzan
 * a cada tabla NUEVA. Las tablas por tenant estaban tapadas por RLS; diez
 * no, porque no son de un tenant — entre ellas `tenants`, `user_profiles` y
 * `platform_admins`, que es quién administra la plataforma.
 *
 * El aviso de Supabase llegó el 19/09. Lo que sigue es lo que evita que
 * vuelva a pasar con la tabla que alguien agregue el mes que viene.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
});

afterAll(async () => {
  await admin.query('DROP TABLE IF EXISTS tabla_recien_agregada');
  await admin.end();
});

describe('el blindaje del esquema', () => {
  it('ninguna tabla queda sin RLS', async () => {
    // El aviso de Supabase dice exactamente esto: «Table publicly
    // accessible: anyone with your project URL can read, edit and delete
    // all data in this table because Row-Level Security is not enabled».
    const r = await admin.query(
      `SELECT c.relname AS tabla
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')`,
    );
    expect(r.rows.map((x) => x.tabla)).toEqual([]);
  });

  it('una tabla NUEVA queda blindada sola, sin que nadie se acuerde', async () => {
    // Es la mitad que importa. Una migración blinda lo que existía el día
    // que se escribió; lo que se publica solo es la tabla que alguien
    // agregue después.
    await admin.query('CREATE TABLE IF NOT EXISTS tabla_recien_agregada (id int)');
    const antes = await admin.query(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'tabla_recien_agregada'`,
    );
    expect(antes.rows[0].relrowsecurity).toBe(false);

    const cliente = await admin.connect();
    try {
      const res = await blindarEsquema(cliente);
      expect(res.conRlsNueva).toContain('tabla_recien_agregada');
    } finally {
      cliente.release();
    }

    const despues = await admin.query(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'tabla_recien_agregada'`,
    );
    expect(despues.rows[0].relrowsecurity).toBe(true);
  });

  it('correrlo dos veces no rompe ni duplica políticas', async () => {
    const cliente = await admin.connect();
    try {
      const segunda = await blindarEsquema(cliente);
      expect(segunda.conRlsNueva).toEqual([]);
    } finally {
      cliente.release();
    }
    const dobles = await admin.query(
      `SELECT tablename, count(*)::int AS n FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'acceso_del_producto'
        GROUP BY 1 HAVING count(*) > 1`,
    );
    expect(dobles.rows).toEqual([]);
  });

  it('el blindaje no le quita nada al producto', async () => {
    // La política permisiva existe para que el rol de la aplicación siga
    // trabajando: sin ella, encender RLS en `tenants` dejaría al producto
    // sin poder leer su propio negocio.
    const r = await admin.query(
      `SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'tenants'
          AND policyname = 'acceso_del_producto'`,
    );
    expect(r.rowCount).toBe(1);
    const filas = await admin.query('SELECT count(*)::int AS n FROM tenants');
    expect(filas.rows[0].n).toBeGreaterThanOrEqual(0); // se puede leer
  });

  it('sin API de datos, no inventa roles que no existen', async () => {
    // En Postgres pelado —local y CI— no hay `anon`: el blindaje enciende
    // RLS y se detiene ahí. Fallar acá dejaría los tests sin base.
    const hay = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'anon'");
    const cliente = await admin.connect();
    try {
      const res = await blindarEsquema(cliente);
      expect(res.hayPostgrest).toBe(hay.rowCount === 1);
    } finally {
      cliente.release();
    }
  });
});
