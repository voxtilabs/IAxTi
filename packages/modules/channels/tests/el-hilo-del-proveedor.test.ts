import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createChannelAccount } from '../application/accounts';
import {
  hiloDe,
  olvidarHilo,
  recordarHilo,
  tomarCandadoDelHilo,
  type ClaveDelHilo,
} from '../application/hilos';

/**
 * El hilo de cada conversación del lado del proveedor (ADR-0033, #1334).
 *
 * Zernio manda DENTRO de una conversación que ya existe, no a un teléfono: el
 * id de esa conversación se aprende de cada mensaje que entra y se usa para
 * contestar. Este archivo prueba las cuatro piezas que sostienen eso contra
 * una base de verdad:
 *
 *  · la RLS de `channel_threads`, con el rol de aplicación de verdad — es una
 *    tabla nueva con `tenant_id`, así que el aislamiento es obligatorio por
 *    regla, y con `FORCE` el que tiene que caer es el rol, no el superusuario;
 *  · `recordarHilo`/`hiloDe` con «último gana», y `olvidarHilo`;
 *  · la FK compuesta a `channel_accounts (id, tenant_id)`: un hilo no puede
 *    apuntar a la cuenta de OTRO tenant aunque alguien se equivoque de id;
 *  · el candado por destinatario, con DOS conexiones de verdad — no
 *    «suponiendo que Postgres serializa», que es lo que la ADR pide medir.
 */

/** La base de pruebas del monorepo: NUNCA el 5432, que es de otro proyecto. */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5433/iaxti_pruebas';

let admin: Pool;
/** El pool con el ROL DE APLICACIÓN: ni superusuario ni dueño de la tabla. */
let app: Pool;
let tenantA: string;
let tenantB: string;
let cuentaA: string;
let cuentaB: string;

/** Un teléfono de mentira, distinto por caso para no cruzar claves. */
const PEER = (n: number) => `+5695555${String(n).padStart(4, '0')}`;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  // El rol de aplicación, como lo arma `channels.test.ts`: la migración 0007
  // da sus GRANTs si el rol ya existía, pero una base que venía de antes lo
  // crea recién acá — así que el GRANT se repite a mano, que es idempotente.
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
        CREATE ROLE iaxti_app LOGIN PASSWORD 'iaxti_app';
      END IF;
    END $$
  `);
  await admin.query('GRANT USAGE ON SCHEMA public TO iaxti_app');
  await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON channel_threads TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));

  tenantA = (
    await admin.query("INSERT INTO tenants (name) VALUES ('hilo-tenant-a') RETURNING id")
  ).rows[0].id;
  tenantB = (
    await admin.query("INSERT INTO tenants (name) VALUES ('hilo-tenant-b') RETURNING id")
  ).rows[0].id;
  cuentaA = (
    await withTenant(admin, tenantA, (c) =>
      createChannelAccount(c, { tenantId: tenantA, kind: 'whatsapp', name: 'Cuenta del hilo A' }),
    )
  ).id;
  cuentaB = (
    await withTenant(admin, tenantB, (c) =>
      createChannelAccount(c, { tenantId: tenantB, kind: 'whatsapp', name: 'Cuenta del hilo B' }),
    )
  ).id;
}, 120_000);

afterAll(async () => {
  await app?.end();
  if (tenantA || tenantB) {
    // Los hilos antes que las cuentas: la FK a tenants no es CASCADE.
    await admin.query('DELETE FROM channel_threads WHERE tenant_id = ANY($1)', [
      [tenantA, tenantB].filter(Boolean),
    ]);
    await admin.query('DELETE FROM channel_accounts WHERE tenant_id = ANY($1)', [
      [tenantA, tenantB].filter(Boolean),
    ]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = ANY($1)', [
      [tenantA, tenantB].filter(Boolean),
    ]);
    await admin.query('DELETE FROM tenants WHERE id = ANY($1)', [
      [tenantA, tenantB].filter(Boolean),
    ]);
  }
  await admin?.end();
});

describe('el hilo del proveedor (#1334, ADR-0033)', () => {
  it('con el rol de aplicación, el tenant A no ve los hilos del B', async () => {
    const claveA: ClaveDelHilo = { tenantId: tenantA, cuentaId: cuentaA, peer: PEER(1) };
    const claveB: ClaveDelHilo = { tenantId: tenantB, cuentaId: cuentaB, peer: PEER(1) };
    await withTenant(app, tenantA, (c) => recordarHilo(c, { ...claveA, hilo: 'hilo-de-a' }));
    await withTenant(app, tenantB, (c) => recordarHilo(c, { ...claveB, hilo: 'hilo-de-b' }));

    // Cada contexto ve el suyo.
    expect(await withTenant(app, tenantA, (c) => hiloDe(c, claveA))).toBe('hilo-de-a');
    expect(await withTenant(app, tenantB, (c) => hiloDe(c, claveB))).toBe('hilo-de-b');

    // Y el de OTRO no, ni pidiéndolo con la clave completa del otro tenant:
    // la política filtra por `tenant_id` antes que la query vea una fila.
    expect(await withTenant(app, tenantA, (c) => hiloDe(c, claveB))).toBeNull();
    expect(await withTenant(app, tenantB, (c) => hiloDe(c, claveA))).toBeNull();

    // Lo que VE cada contexto son solo sus filas: una por tenant.
    const deA = await withTenant(app, tenantA, (c) =>
      c.query('SELECT count(*)::int AS n FROM channel_threads'),
    );
    expect(deA.rows[0].n).toBe(1);
    const deB = await withTenant(app, tenantB, (c) =>
      c.query('SELECT count(*)::int AS n FROM channel_threads'),
    );
    expect(deB.rows[0].n).toBe(1);

    // Y sin contexto de tenant no se ve NADA: `FORCE` hace que la política
    // aplique también al que createa, y el rol de aplicación no es dueño.
    // Es la medición que importa: con el superusuario esta consulta ve todo.
    const sinContexto = await app.query('SELECT count(*)::int AS n FROM channel_threads');
    expect(sinContexto.rows[0].n).toBe(0);
  });

  it('recordarHilo/hiloDe: el último gana', async () => {
    const clave: ClaveDelHilo = { tenantId: tenantA, cuentaId: cuentaA, peer: PEER(2) };
    expect(await withTenant(app, tenantA, (c) => hiloDe(c, clave))).toBeNull();
    await withTenant(app, tenantA, (c) => recordarHilo(c, { ...clave, hilo: 'hilo-viejo' }));
    expect(await withTenant(app, tenantA, (c) => hiloDe(c, clave))).toBe('hilo-viejo');
    // El proveedor rehizo la conversación y el próximo webhook trae el id
    // nuevo: ese es el que vale, aunque el viejo todavía esté guardado.
    await withTenant(app, tenantA, (c) => recordarHilo(c, { ...clave, hilo: 'hilo-nuevo' }));
    expect(await withTenant(app, tenantA, (c) => hiloDe(c, clave))).toBe('hilo-nuevo');
  });

  it('olvidarHilo borra la fila, y olvidar una clave sin fila no tira', async () => {
    const clave: ClaveDelHilo = { tenantId: tenantA, cuentaId: cuentaA, peer: PEER(3) };
    await withTenant(app, tenantA, (c) => recordarHilo(c, { ...clave, hilo: 'hilo-por-borrar' }));
    expect(await withTenant(app, tenantA, (c) => hiloDe(c, clave))).toBe('hilo-por-borrar');
    await withTenant(app, tenantA, (c) => olvidarHilo(c, clave));
    expect(await withTenant(app, tenantA, (c) => hiloDe(c, clave))).toBeNull();
    // El 404 puede llegar dos veces antes de que el reintento pase: olvidar
    // lo que ya no está tiene que ser un no-ops, no un error nuevo.
    await expect(withTenant(app, tenantA, (c) => olvidarHilo(c, clave))).resolves.toBeUndefined();
  });

  it('la FK compuesta: un hilo del tenant A no puede apuntar a la cuenta del B', async () => {
    // Con `tenant_id` de A y la cuenta de B la POLÍTICA no tira: el contexto
    // es el de A y `tenant_id` es el de A, así que el WITH CHECK pasa. Lo que
    // lo frena es la FK compuesta a `channel_accounts (id, tenant_id)` — la
    // misma que ya usa `channel_senders` —, que es exactamente el hueco que
    // esta FK existe para cerrar.
    await expect(
      withTenant(app, tenantA, (c) =>
        recordarHilo(c, {
          tenantId: tenantA,
          cuentaId: cuentaB,
          peer: PEER(4),
          hilo: 'hilo-cruzado',
        }),
      ),
    ).rejects.toThrow(/foreign key/);
    // Y no quedó nada del intento.
    const cruzado = await withTenant(app, tenantA, (c) =>
      c.query('SELECT count(*)::int AS n FROM channel_threads WHERE channel_account_id = $1', [
        cuentaB,
      ]),
    );
    expect(cruzado.rows[0].n).toBe(0);
  });
});

describe('el candado por destinatario, con dos conexiones de verdad (#1334)', () => {
  /**
   * La ADR pide medir la concurrencia «de verdad, no suponiendo»: dos
   * conexiones del pool, cada una en su transacción, como dos procesos
   * worker distintos. Una carrera con `Promise.race` es la medición: si el
   * candado no existiera, el `pg_advisory_xact_lock` de la segunda volvería
   * en milisegundos y diría «volvió».
   */
  const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it('la misma clave: la segunda espera hasta el COMMIT de la primera', async () => {
    const c1 = await admin.connect();
    const c2 = await admin.connect();
    try {
      await c1.query('BEGIN');
      await c1.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      await c2.query('BEGIN');
      await c2.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      const clave: ClaveDelHilo = { tenantId: tenantA, cuentaId: cuentaA, peer: PEER(5) };

      // La primera toma el candado y sigue: nadie lo tenía.
      await tomarCandadoDelHilo(c1, clave);

      let c2Termino = 0;
      const c2TomoElCandado = tomarCandadoDelHilo(c2, clave).then(() => {
        c2Termino = Date.now();
      });
      // Que la base la tenga listada como espera advisory: quedó esperando
      // el candado y no por otra cosa.
      await vi.waitFor(async () => {
        const esperando = await admin.query(
          `SELECT 1 FROM pg_stat_activity
             WHERE usename = current_user AND wait_event = 'advisory'
               AND query LIKE '%pg_advisory_xact_lock%'`,
        );
        expect(esperando.rowCount).toBeGreaterThan(0);
      });
      // Y mientras la primera no suelte, no termina.
      expect(
        await Promise.race([c2TomoElCandado.then(() => 'volvio'), esperar(120).then(() => 'esperando')]),
      ).toBe('esperando');

      const antesDeSoltar = Date.now();
      await c1.query('COMMIT'); // el candado es de la transacción: se suelta acá
      await c2TomoElCandado;
      expect(c2Termino).toBeGreaterThanOrEqual(antesDeSoltar);
    } finally {
      await c1.query('ROLLBACK').catch(() => {});
      await c2.query('ROLLBACK').catch(() => {});
      c1.release();
      c2.release();
    }
  });

  it('claves distintas no se esperan', async () => {
    const c1 = await admin.connect();
    const c2 = await admin.connect();
    try {
      await c1.query('BEGIN');
      await c1.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      await c2.query('BEGIN');
      await c2.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);

      // La primera deja su transacción ABIERTA con el candado puesto: si el
      // candado serializara de más —por destinatario equivocado, o por
      // cuenta—, la segunda se quedaría esperando un COMMIT que no llega.
      await tomarCandadoDelHilo(c1, { tenantId: tenantA, cuentaId: cuentaA, peer: PEER(6) });
      const volvio = await Promise.race([
        tomarCandadoDelHilo(c2, { tenantId: tenantA, cuentaId: cuentaA, peer: PEER(7) }).then(
          () => 'volvio',
        ),
        esperar(300).then(() => 'esperando'),
      ]);
      expect(volvio, 'un destinatario distinto no tiene por qué esperar al otro').toBe('volvio');
    } finally {
      await c1.query('ROLLBACK').catch(() => {});
      await c2.query('ROLLBACK').catch(() => {});
      c1.release();
      c2.release();
    }
  });
});