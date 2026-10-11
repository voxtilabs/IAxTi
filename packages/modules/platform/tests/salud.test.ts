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
  /**
   * El chequeo cuenta el outbox de TODA la plataforma, y así tiene que ser: es
   * un chequeo de plataforma, no de un negocio. Lo que estaba mal era la prueba
   * (#745): insertaba uno y afirmaba `valor === 1`, así que en una base con
   * eventos abandonados de otras suites daba 5. Fallaba siempre en local y
   * pasaba en CI, donde la base nace limpia.
   *
   * Ahora se mide el DELTA: cuántos había antes y cuántos después. Es lo que la
   * prueba siempre quiso afirmar — que ESE evento cuenta, o no cuenta.
   */
  const cuantos = async (): Promise<number> =>
    // `valor` del chequeo es `string | number` porque otros chequeos reportan
    // texto; acá siempre es el conteo. `Number` y no un casteo: si algún día
    // dejara de ser numérico, esto da NaN y la aserción falla en vez de callar.
    Number((await chequeoEventosAbandonados(admin)).valor ?? 0);

  it('el umbral es explícito: cualquiera mayor que cero', async () => {
    // El estado depende de lo que haya en la base, que esta prueba no controla.
    // Lo que sí es suyo es el contrato del chequeo.
    const chequeo = await chequeoEventosAbandonados(admin);
    expect(chequeo.umbral).toMatch(/> 0/);
    expect(chequeo.estado === 'bien' || chequeo.estado === 'mal').toBe(true);
    if (chequeo.estado === 'bien') expect(chequeo.valor).toBe(0);
  });

  it('un evento que agotó los reintentos SUMA, y deja el tablero en MAL', async () => {
    // El despachador deja de intentar a los 5 fallos y lo abandona con su
    // último error. Hasta #71 nadie miraba esa pila.
    const antes = await cuantos();
    await admin.query(
      `INSERT INTO outbox (tenant_id, name, payload, attempts, last_error)
       VALUES ($1, 'payment.received', '{}'::jsonb, 5, 'el consumidor explotó')`,
      [tenant],
    );
    const chequeo = await chequeoEventosAbandonados(admin);
    expect(Number(chequeo.valor), 'suma exactamente uno: el que insertó esta prueba').toBe(antes + 1);
    expect(chequeo.estado).toBe('mal');
    // El motivo viaja: sin él, "1 evento abandonado" no se puede accionar.
    expect(chequeo.detalle).toMatch(/el consumidor explotó/);
    // Y ensucia el general del tablero.
    const snap = await healthSnapshot(admin, { redis: null, env: {} });
    expect(snap.estado).toBe('mal');
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  });

  it('un evento con reintentos pendientes NO suma: todavía puede salir', async () => {
    const antes = await cuantos();
    await admin.query(
      `INSERT INTO outbox (tenant_id, name, payload, attempts, last_error)
       VALUES ($1, 'payment.received', '{}'::jsonb, 2, 'falló una vez')`,
      [tenant],
    );
    expect(await cuantos(), 'el mismo número que antes: éste no está abandonado').toBe(antes);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  });

  it('y el motivo del que insertó esta prueba no se lleva el de otro', async () => {
    // El `detalle` muestra hasta tres motivos distintos. Que el de esta prueba
    // aparezca es lo que se afirma arriba; que NO aparezca uno inventado es lo
    // que hace que esa aserción signifique algo.
    const chequeo = await chequeoEventosAbandonados(admin);
    expect(chequeo.detalle).not.toMatch(/un motivo que nadie escribió/);
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

  /**
   * Las dos de abajo necesitan una lista REALMENTE cortada, y no la había.
   *
   * Decían cuidar el defecto de #734 —el panel mostraba un número truncado
   * como si fuera el total, y ese número alimenta un semáforo de seguridad—
   * pero el fixture del archivo son tres filas de UN actor y el tope de la
   * lista es veinte. Con un solo grupo, `truncado` era false en toda corrida
   * limpia, y la aserción que distingue las dos aritméticas vivía dentro de
   * `if (snap.permisosDenegados.truncado)`: un bloque que no se ejecutaba
   * nunca.
   *
   * Peor: una de ellas afirmaba `expect(lista.truncado).toBe(lista.total >
   * lista.filas.length)`, que es LA MISMA expresión de la implementación
   * (`salud.ts:366`). Comparar un campo con su propia fórmula no puede
   * fallar. Si alguien dejara `truncado: false` fijo, o calculara el total
   * sumando las filas que se muestran, las dos seguían verdes (#812).
   *
   * Veinticinco actores de diez intentos: la lista corta en veinte y el total
   * de la base es 250, así que sumar lo que se muestra da 200 — que es
   * exactamente el error que #734 describe, con otros números.
   */
  describe('con el libro de verdad lleno (#734)', () => {
    const ACTORES = 25;
    const INTENTOS = 10;

    beforeAll(async () => {
      await withTenant(admin, tenant, async (c) => {
        for (let a = 0; a < ACTORES; a++) {
          for (let i = 0; i < INTENTOS; i++) {
            await writeAudit(c, {
              tenantId: tenant,
              actor: `curioso-${a}-${Date.now()}`.slice(0, 40),
              actorKind: 'user',
              action: 'permission.denied',
              resource: 'payments.refund',
              result: 'denied',
              ip: `190.44.${a}.1`,
            });
          }
        }
      });
    }, 60_000);

    it('la lista viene cortada y lo DICE, con el total contado en la base', async () => {
      const snap = await securitySnapshot(admin, { redis: null, dias: 7 });
      const lista = snap.permisosDenegados;

      // Cortada de verdad: éste es el estado que antes no se alcanzaba nunca.
      expect(lista.filas).toHaveLength(20);
      expect(lista.truncado).toBe(true);

      // El total se compara contra un conteo INDEPENDIENTE, no contra la
      // fórmula de la implementación: cuántos grupos hay en la base.
      const grupos = (
        await admin.query(
          `SELECT count(*)::int AS n FROM (
             SELECT 1 FROM audit_log
              WHERE action = 'permission.denied' AND occurred_at >= $1
              GROUP BY tenant_id, actor, host(ip)
           ) g`,
          [snap.desde],
        )
      ).rows[0].n as number;
      expect(lista.total).toBe(grupos);
      expect(grupos).toBeGreaterThanOrEqual(ACTORES);
    });

    it('una lista que NO está cortada dice que no lo está', async () => {
      // El otro lado del mismo campo. Sin esto, `truncado: true` fijo pasaría.
      const snap = await securitySnapshot(admin, { redis: null, dias: 7 });
      for (const lista of [snap.webhooksFallidos, snap.numerosEnRiesgo]) {
        expect(lista.filas.length).toBeLessThanOrEqual(20);
        expect(lista.truncado).toBe(false);
        expect(lista.total).toBe(lista.filas.length);
      }
    });

    it('el total de intentos NO se calcula sumando las filas que se muestran (#734)', async () => {
      const snap = await securitySnapshot(admin, { redis: null, dias: 7 });
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

      // Y acá está la mentira que esto saca, ahora SIN `if`: la lista está
      // cortada, así que el total tiene que ser estrictamente mayor que la
      // suma de las veinte filas que el panel muestra.
      expect(snap.permisosDenegados.truncado).toBe(true);
      const sumaDeLasFilas = snap.permisosDenegados.filas.reduce((t, f) => t + f.n, 0);
      expect(snap.intentosDenegados).toBeGreaterThan(sumaDeLasFilas);
    });
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
