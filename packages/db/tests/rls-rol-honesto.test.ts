import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/client';
import { runMigrations } from '../src/migrate';
import { estadoRls, exigeRolQueRespetaRls } from '../src/rls';

/**
 * Postgres no evalúa las políticas cuando el rol es superusuario o tiene
 * BYPASSRLS (issue 211). Las políticas del repo son correctas; lo que
 * faltaba era impedir conectarse con un rol que las ignora.
 *
 * Este test usa los DOS roles y comprueba las dos cosas que importan: que
 * sabemos distinguirlos, y que uno de ellos ve lo que no debería.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const APP_URL = ADMIN_URL.replace(/\/\/[^:]+:[^@]+@/, '//iaxti_app:iaxti_app@');

let admin: Pool;
let app: Pool;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
      CREATE ROLE iaxti_app LOGIN PASSWORD 'iaxti_app';
    END IF;
  END $$;`);
  await admin.query("ALTER ROLE iaxti_app NOSUPERUSER NOBYPASSRLS PASSWORD 'iaxti_app'");
  await admin.query('GRANT USAGE ON SCHEMA public TO iaxti_app');
  await admin.query('GRANT SELECT ON contacts, tenants TO iaxti_app');
  app = createPool(APP_URL);

  const a = await admin.query("INSERT INTO tenants (name) VALUES ('rls-honesto-a') RETURNING id");
  const b = await admin.query("INSERT INTO tenants (name) VALUES ('rls-honesto-b') RETURNING id");
  tenantA = a.rows[0].id;
  tenantB = b.rows[0].id;
  await admin.query(
    "INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1, 'Ajena', '+56900000911', 'manual')",
    [tenantB],
  );
});

afterAll(async () => {
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenantB]);
  await admin.query('DELETE FROM tenants WHERE id IN ($1, $2)', [tenantA, tenantB]);
  await app.end();
  await admin.end();
});

describe('el rol de la conexión decide si RLS existe (issue 211)', () => {
  it('sabemos reconocer una conexión que se salta las políticas', async () => {
    const dueño = await estadoRls(admin);
    const aplicacion = await estadoRls(app);
    expect(aplicacion.seSalta).toBe(false);
    expect(aplicacion.rol).toBe('iaxti_app');
    // El dueño de la base en local y en CI es superusuario: eso es
    // exactamente lo que este guardián existe para detectar.
    expect(dueño.seSalta).toBe(dueño.superusuario || dueño.bypassrls);
  });

  it('y no es teórico: con el rol equivocado se ven las filas del otro tenant', async () => {
    const ver = async (pool: Pool) => {
      const c = await pool.connect();
      try {
        await c.query('SELECT set_config($1, $2, false)', ['app.tenant_id', tenantA]);
        const r = await c.query('SELECT count(*)::int AS n FROM contacts');
        return r.rows[0].n as number;
      } finally {
        c.release();
      }
    };
    // El rol de aplicación: cero, que es lo correcto — la fila es del otro.
    expect(await ver(app)).toBe(0);
    const dueño = await estadoRls(admin);
    if (dueño.seSalta) expect(await ver(admin)).toBeGreaterThan(0);
  });

  it('grita en todos lados y no mata el proceso en ninguno', async () => {
    // Con un rol de mentira, para que la regla no dependa de cómo esté
    // configurada la base de quien corra el test.
    const comoSuperusuario = {
      query: async () => ({ rows: [{ rol: 'postgres', super: true, bypass: false }] }),
    } as unknown as Pool;

    // Ni producción: un proceso muerto al arrancar es un 404 sin
    // explicación (issue 227 se ocupa de negarse a servir, que es distinto).
    await expect(exigeRolQueRespetaRls(comoSuperusuario, 'production')).resolves.toMatchObject({
      seSalta: true,
    });
    await expect(exigeRolQueRespetaRls(comoSuperusuario, 'staging')).resolves.toMatchObject({
      seSalta: true,
    });
    await expect(exigeRolQueRespetaRls(comoSuperusuario, 'development')).resolves.toMatchObject({
      seSalta: true,
    });
    // Y el rol de aplicación de verdad pasa en cualquier entorno.
    await expect(exigeRolQueRespetaRls(app, 'production')).resolves.toMatchObject({ seSalta: false });
  });

  it('si la base no contesta, la aplicación arranca igual y lo dice', async () => {
    // Una comprobación de seguridad no puede volverse una dependencia dura
    // del arranque: `/health` es liveness justamente para no tener ninguna.
    const caida = {
      query: async () => {
        throw new Error('ECONNREFUSED');
      },
    } as unknown as Pool;
    const estado = await exigeRolQueRespetaRls(caida, 'production', 1);
    expect(estado).toMatchObject({ verificado: false, seSalta: false, rol: 'desconocido' });
  });
});
