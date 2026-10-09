import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';
import {
  chequeoCrecimientoMensajes,
  chequeoEventosAbandonados,
  estadoGeneral,
  healthSnapshot,
  securitySnapshot,
} from '../application/salud';

// Seguridad y salud (#71): que cada número salga de una fuente real, y que
// lo que no tiene fuente lo diga en vez de mostrar un cero tranquilizador.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('salud-test') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete');
  await admin.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]);
  await admin.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete');
  await admin.query('DELETE FROM whatsapp_numbers WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

describe('estado general', () => {
  it('manda el peor chequeo, y "sin fuente" no se confunde con "bien"', () => {
    expect(estadoGeneral([])).toBe('bien');
    expect(
      estadoGeneral([
        { id: 'a', titulo: 'a', estado: 'bien', detalle: '' },
        { id: 'b', titulo: 'b', estado: 'atencion', detalle: '' },
      ]),
    ).toBe('atencion');
    expect(
      estadoGeneral([
        { id: 'a', titulo: 'a', estado: 'atencion', detalle: '' },
        { id: 'b', titulo: 'b', estado: 'mal', detalle: '' },
      ]),
    ).toBe('mal');
    // Un chequeo sin fuente ensucia el general: no sabemos, no es que esté bien.
    expect(
      estadoGeneral([
        { id: 'a', titulo: 'a', estado: 'bien', detalle: '' },
        { id: 'b', titulo: 'b', estado: 'sin_fuente', detalle: '' },
      ]),
    ).toBe('sin_fuente');
  });
});

describe('salud (#71)', () => {
  it('mide la base, y sin Redis lo dice en vez de callarlo', async () => {
    const snap = await healthSnapshot(admin, { redis: null, env: {} });
    const pg = snap.chequeos.find((c) => c.id === 'postgres')!;
    expect(pg.estado).toBe('bien');
    expect(typeof pg.valor).toBe('number');
    expect(pg.umbral).toBeTruthy();

    const redis = snap.chequeos.find((c) => c.id === 'redis')!;
    expect(redis.estado).toBe('sin_fuente');
    expect(redis.detalle).toMatch(/REDIS_URL/);
    // Ningún chequeo puede quedar sin explicación en palabras.
    expect(snap.chequeos.every((c) => c.detalle.length > 0)).toBe(true);
  });

  it('los proveedores se informan por configuración, sin hacerles ping', async () => {
    const sinNada = await healthSnapshot(admin, { redis: null, env: {} });
    const canales = sinNada.chequeos.find((c) => c.id === 'proveedor.canales')!;
    expect(canales.estado).toBe('sin_fuente');
    expect(canales.detalle).toMatch(/ZAVU_API_KEY/);

    const configurado = await healthSnapshot(admin, {
      redis: null,
      env: { ZAVU_API_KEY: 'zv_test_x' } as NodeJS.ProcessEnv,
    });
    expect(configurado.chequeos.find((c) => c.id === 'proveedor.canales')!.estado).toBe('bien');
  });

  it('el estado general resume el peor de los chequeos', async () => {
    const snap = await healthSnapshot(admin, { redis: null, env: {} });
    expect(snap.estado).toBe(estadoGeneral(snap.chequeos));
    expect(snap.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('umbral de particionado (#84)', () => {
  it('avisa por estimación, no contando filas de a una', async () => {
    const chequeo = await chequeoCrecimientoMensajes(admin);
    // En una base de pruebas está lejísimos del umbral: tiene que decirlo
    // así, y traer el número que midió.
    expect(chequeo.estado).toBe('bien');
    expect(chequeo.detalle).toMatch(/lejos del umbral/);
    expect(typeof chequeo.valor).toBe('number');
    // El umbral explica de dónde sale el número: es una estimación.
    expect(chequeo.umbral).toMatch(/estimación del planificador/);
  });

  it('el chequeo entra al tablero de salud', async () => {
    const snap = await healthSnapshot(admin, { redis: null, env: {} });
    expect(snap.chequeos.some((c) => c.id === 'mensajes')).toBe(true);
  });
});

describe('eventos abandonados (#71)', () => {
  it('sin abandonados dice que no hay, con el umbral explícito', async () => {
    const chequeo = await chequeoEventosAbandonados(admin);
    expect(chequeo.estado).toBe('bien');
    expect(chequeo.valor).toBe(0);
    expect(chequeo.umbral).toMatch(/> 0/);
  });

  it('un evento que agotó los reintentos es MAL, no "atención"', async () => {
    // El despachador deja de intentar a los 5 fallos y lo abandona con su
    // último error. Hasta ahora nadie miraba esa pila.
    await admin.query(
      `INSERT INTO outbox (tenant_id, name, payload, attempts, last_error)
       VALUES ($1, 'payment.received', '{}'::jsonb, 5, 'el consumidor explotó')`,
      [tenant],
    );
    const chequeo = await chequeoEventosAbandonados(admin);
    expect(chequeo.estado).toBe('mal');
    expect(chequeo.valor).toBe(1);
    // El motivo viaja: sin él, "1 evento abandonado" no se puede accionar.
    expect(chequeo.detalle).toMatch(/el consumidor explotó/);
    // Y ensucia el general del tablero.
    const snap = await healthSnapshot(admin, { redis: null, env: {} });
    expect(snap.estado).toBe('mal');
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  });

  it('un evento con reintentos pendientes NO cuenta: todavía puede salir', async () => {
    await admin.query(
      `INSERT INTO outbox (tenant_id, name, payload, attempts, last_error)
       VALUES ($1, 'payment.received', '{}'::jsonb, 2, 'falló una vez')`,
      [tenant],
    );
    expect((await chequeoEventosAbandonados(admin)).valor).toBe(0);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  });
});

describe('seguridad (#71)', () => {
  it('cuenta los permisos denegados desde el libro de auditoría, con su IP', async () => {
    // Las denegaciones se buscan en la base y no en las veinte filas que el
    // panel muestra (#734): antes este `find` fallaba en cuanto el libro de
    // auditoría acumulaba más de veinte actores con más intentos que éste, y
    // pasaba en CI solo porque allá la base nace limpia.
    const actor = `user-curioso-${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      await withTenant(admin, tenant, (c) =>
        writeAudit(c, {
          tenantId: tenant,
          actor,
          actorKind: 'user',
          action: 'permission.denied',
          resource: 'payments.refund',
          result: 'denied',
          ip: '190.44.9.9',
        }),
      );
    }
    const fila = (
      await admin.query(
        `SELECT actor, host(ip) AS ip, count(*)::int AS n
           FROM audit_log
          WHERE action = 'permission.denied' AND actor = $1
          GROUP BY actor, host(ip)`,
        [actor],
      )
    ).rows[0];
    expect(fila).toBeDefined();
    expect(fila.n).toBe(3);
    expect(fila.ip).toBe('190.44.9.9');

    const snap = await securitySnapshot(admin, { redis: null, dias: 7 });
    const chequeo = snap.chequeos.find((c) => c.id === 'permisos')!;
    expect(chequeo.detalle).toMatch(/intentos sin permiso/);
    expect(chequeo.umbral).toBeTruthy();
    // El total sale de la base, así que incluye a este actor aunque sus tres
    // intentos no entren en la lista de los veinte más activos.
    expect(snap.intentosDenegados).toBeGreaterThanOrEqual(3);
  });

  it('una lista cortada DICE que está cortada (#734)', async () => {
    // Era el patrón que `listarCampanas` ya había resuelto: «sin ese dato, una
    // lista cortada se ve exactamente igual que una lista completa, y eso es
    // mentir en silencio». Acá era peor, porque el número truncado alimentaba
    // un semáforo de seguridad.
    const snap = await securitySnapshot(admin, { redis: null, dias: 7 });
    for (const lista of [snap.permisosDenegados, snap.webhooksFallidos, snap.numerosEnRiesgo]) {
      expect(lista.filas.length).toBeLessThanOrEqual(20);
      expect(lista.total).toBeGreaterThanOrEqual(lista.filas.length);
      expect(lista.truncado).toBe(lista.total > lista.filas.length);
    }
  });

  it('el total de intentos NO se calcula sumando las filas que se muestran (#734)', async () => {
    // Con treinta actores de diez intentos cada uno, sumar las veinte filas
    // daba 200 y habían sido 300 — y ése es el número que enciende el semáforo.
    const snap = await securitySnapshot(admin, { redis: null, dias: 7 });
    // El total tiene que calzar EXACTO con lo que hay en la base, contado
    // aparte. Sumando las veinte filas calzaría solo si no hubiera más de
    // veinte grupos, y es justo cuando hay más que el número importa.
    const enLaBase = (
      await admin.query(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE action = 'permission.denied' AND occurred_at >= $1`,
        [snap.desde],
      )
    ).rows[0].n as number;
    expect(snap.intentosDenegados).toBe(enLaBase);
    const chequeo = snap.chequeos.find((c) => c.id === 'permisos')!;
    expect(chequeo.valor).toBe(snap.intentosDenegados);
    // Y si la lista viene cortada, el total es ESTRICTAMENTE mayor que la suma
    // de lo que se muestra: ahí está la mentira que esto saca.
    if (snap.permisosDenegados.truncado) {
      const sumaDeLasFilas = snap.permisosDenegados.filas.reduce((t, f) => t + f.n, 0);
      expect(snap.intentosDenegados).toBeGreaterThan(sumaDeLasFilas);
    }
  });

  it('un número en rojo es "mal", no "atención": deja al cliente sin canal', async () => {
    const cuenta = await admin.query(
      `INSERT INTO channel_accounts (tenant_id, kind, name, state, credential_ref, webhook_secret_ref, config)
       VALUES ($1, 'whatsapp', 'test', 'active', 'X', 'Y', '{}'::jsonb) RETURNING id`,
      [tenant],
    );
    await admin.query(
      `INSERT INTO whatsapp_numbers (tenant_id, channel_account_id, sender_id, display_phone, quality)
       VALUES ($1, $2, 'snd-rojo', '+56 9 0000 0000', 'red')`,
      [tenant, cuenta.rows[0].id],
    );
    const snap = await securitySnapshot(admin, { redis: null });
    expect(snap.numerosEnRiesgo.filas.some((n) => n.display_phone === '+56 9 0000 0000')).toBe(true);
    expect(snap.chequeos.find((c) => c.id === 'numeros')!.estado).toBe('mal');
    expect(snap.estado).toBe('mal');
  });
});
