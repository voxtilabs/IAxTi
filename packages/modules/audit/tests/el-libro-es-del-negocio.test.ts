import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant, estadoRls } from '@iaxti/db';
import { writeAudit } from '../src/write';
import { exportAudit, exportAuditDelTenant, searchAudit, searchAuditPaginado } from '../src/search';

/**
 * El libro de un negocio no trae filas de otro, aunque RLS esté apagado
 * (#960).
 *
 * Las rutas del libro corren dentro de `withTenant`, así que la política ya
 * acota. El problema era que esa fuera la ÚNICA defensa: staging corre con un
 * rol BYPASSRLS (#370), y ahí la política no se evalúa. Un ADMIN con
 * `audit.export` se llevaba el libro de toda la plataforma en un archivo
 * firmado por nosotros.
 *
 * No lo encontró una prueba de aislamiento: lo encontró el tope del export. En
 * la base local —superusuario, la misma condición que staging— `audit_log`
 * cruzó las 50.000 filas repartidas en 12.243 negocios y el export del libro
 * de UNO, con 51 filas, empezó a dar 413. O sea: estaba leyendo 50.366 filas
 * ajenas, y mientras la base tuvo menos de 50.000 no se encendió nada.
 *
 * Por eso esta prueba corre con un rol que SE SALTA las políticas. Con uno que
 * las respeta no podría fallar: RLS taparía el defecto y la prueba diría que
 * sí cuando la pregunta es si hay una segunda defensa.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
/**
 * El mismo actor en los dos negocios, para que UN filtro alcance las dos
 * filas. El export global sin filtro se lleva el libro entero de la base, y en
 * una base compartida eso son decenas de miles de filas de otras pruebas: la
 * prueba fallaría por el tope del export y no por lo que viene a mirar.
 */
const ACTOR = 'user-960';
const ROL = 'iaxti_bypass_960';
const BYPASS_URL = ADMIN_URL.replace(/\/\/[^:]+:[^@]+@/, `//${ROL}:${ROL}@`);

let admin: Pool;
let bypass: Pool;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROL}') THEN
      CREATE ROLE ${ROL} LOGIN PASSWORD '${ROL}';
    END IF;
  END $$;`);
  // El rol de staging, tal cual: no es superusuario pero se salta RLS, que es
  // la mitad que importa y la que #370 todavía no corrige.
  await admin.query(`ALTER ROLE ${ROL} NOSUPERUSER BYPASSRLS PASSWORD '${ROL}'`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROL}`);
  await admin.query(`GRANT SELECT ON audit_log TO ${ROL}`);
  bypass = createPool(BYPASS_URL);

  tenantA = (await admin.query("INSERT INTO tenants (name) VALUES ('libro-960-a') RETURNING id"))
    .rows[0].id;
  tenantB = (await admin.query("INSERT INTO tenants (name) VALUES ('libro-960-b') RETURNING id"))
    .rows[0].id;

  // Una entrada de cada negocio. La del vecino lleva una acción distinta para
  // que se pueda nombrar en el error cuando aparezca donde no debe.
  await withTenant(admin, tenantA, (c) =>
    writeAudit(c, {
      tenantId: tenantA,
      actor: ACTOR,
      actorKind: 'user',
      action: 'prueba.960.mia',
      resource: 'contact',
      resourceId: 'a-1',
      result: 'ok',
    }),
  );
  await withTenant(admin, tenantB, (c) =>
    writeAudit(c, {
      tenantId: tenantB,
      actor: ACTOR,
      actorKind: 'user',
      action: 'prueba.960.del_vecino',
      resource: 'contact',
      resourceId: 'b-1',
      result: 'ok',
    }),
  );
});

afterAll(async () => {
  await bypass.end();
  await admin.query(`REVOKE ALL ON audit_log FROM ${ROL}`).catch(() => undefined);
  await admin.query(`REVOKE USAGE ON SCHEMA public FROM ${ROL}`).catch(() => undefined);
  await admin.query(`DROP ROLE IF EXISTS ${ROL}`).catch(() => undefined);
  // El libro no se borra: es append-only y un trigger rechaza el DELETE. Los
  // tenants se quedan con él por la FK. Es la regla funcionando.
  await admin.end();
});

const acciones = (filas: Array<Record<string, unknown>>) => filas.map((f) => f.action);

describe('el libro es del negocio, no de la plataforma (#960)', () => {
  it('la prueba está mirando algo: esta conexión SE SALTA las políticas', async () => {
    // Anti-vacuidad. Si el rol respetara RLS, las tres de abajo pasarían con
    // el defecto puesto y esta prueba no probaría nada.
    const estado = await estadoRls(bypass);
    expect(estado.seSalta).toBe(true);
  });

  it('la búsqueda del libro no trae el libro del vecino', async () => {
    const filas = await withTenant(bypass, tenantA, (c) => searchAudit(c, {}));

    expect(acciones(filas)).toContain('prueba.960.mia');
    expect(acciones(filas)).not.toContain('prueba.960.del_vecino');
  });

  it('la búsqueda paginada tampoco', async () => {
    const { entries } = await withTenant(bypass, tenantA, (c) => searchAuditPaginado(c, {}));

    expect(acciones(entries)).not.toContain('prueba.960.del_vecino');
  });

  it('el export firmado tampoco: es lo que sale del sistema y se queda afuera', async () => {
    const filas = await withTenant(bypass, tenantA, (c) => exportAuditDelTenant(c, {}));

    expect(acciones(filas)).toContain('prueba.960.mia');
    expect(acciones(filas)).not.toContain('prueba.960.del_vecino');
  });

  it('el libro global del SUPERADMIN SÍ cruza negocios: ahí es el trabajo', async () => {
    // La otra mitad del arreglo. Si el recorte se hubiera metido en la
    // consulta compartida, la pantalla de soporte se habría quedado ciega y
    // nadie lo habría notado hasta que alguien la abriera.
    const c = await bypass.connect();
    try {
      const filas = await exportAudit(c, { actor: ACTOR });

      expect(acciones(filas)).toContain('prueba.960.mia');
      expect(acciones(filas)).toContain('prueba.960.del_vecino');
    } finally {
      c.release();
    }
  });
});
