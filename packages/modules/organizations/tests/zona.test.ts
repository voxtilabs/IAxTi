import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { diaEn } from '@iaxti/core';
import { olvidarZonas, zonaDelTenant } from '../application/zona';

// `tenants.timezone` existía, era editable y se ignoraba en todas partes.
// Mientras todos los clientes sean chilenos no se nota; el día que alguien
// ponga otra zona, sus números salen mal sin fallar.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let chileno: string;
let mexicano: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const a = await admin.query("INSERT INTO tenants (name) VALUES ('zona-cl') RETURNING id");
  const b = await admin.query(
    "INSERT INTO tenants (name, timezone) VALUES ('zona-mx', 'America/Mexico_City') RETURNING id",
  );
  chileno = a.rows[0].id;
  mexicano = b.rows[0].id;
  olvidarZonas();
});

afterAll(async () => {
  await admin.end();
});

describe('la zona del negocio', () => {
  it('cada tenant responde con la suya; sin declarar, la del producto', async () => {
    const cl = await withTenant(admin, chileno, (c) => zonaDelTenant(c, chileno));
    const mx = await withTenant(admin, mexicano, (c) => zonaDelTenant(c, mexicano));
    expect(cl).toBe('America/Santiago');
    expect(mx).toBe('America/Mexico_City');
  });

  it('dos negocios en zonas distintas cierran el día en momentos distintos', async () => {
    // 15 de septiembre 02:30 UTC: en Chile (-03) es el 14 a las 23:30; en
    // Ciudad de México (-06) es el 14 a las 20:30. Mismo instante, mismo
    // día de calendario — pero tres horas después ya no.
    const finDeDiaChileno = new Date('2026-09-15T04:30:00Z'); // CL: 01:30 del 15 · MX: 22:30 del 14
    const cl = await withTenant(admin, chileno, (c) => zonaDelTenant(c, chileno));
    const mx = await withTenant(admin, mexicano, (c) => zonaDelTenant(c, mexicano));
    expect(diaEn(cl, finDeDiaChileno)).toBe('2026-09-15');
    expect(diaEn(mx, finDeDiaChileno)).toBe('2026-09-14');
  });

  it('un tenant que no existe no revienta: cae a la zona del producto', async () => {
    olvidarZonas();
    const zona = await withTenant(admin, chileno, (c) =>
      zonaDelTenant(c, '00000000-0000-0000-0000-000000000000'),
    );
    expect(zona).toBe('America/Santiago');
  });
});

/**
 * Cuando la lectura de la zona falla DENTRO de una transacción ajena (#962).
 *
 * Esta función recibe el cliente de quien llama, y casi siempre viene dentro
 * de una transacción. Antes se tragaba el error de su `SELECT` con un
 * `.catch()`: en Postgres eso no deja las cosas como estaban, deja la
 * transacción ABORTADA, y lo que el llamador hiciera después contestaba
 * `current transaction is aborted`. El consumidor de analytics se agotaba a
 * los cinco intentos con ese mensaje, que no nombra ni `tenants` ni el
 * permiso que faltaba.
 */
describe('si no se puede leer la zona, el que llamó sigue trabajando (#962)', () => {
  /** Desvía el `SELECT … FROM tenants` de ESTA conexión a una tabla que no existe. */
  function clienteSinTenants(cliente: PoolClient): PoolClient {
    const consultar = cliente.query.bind(cliente) as unknown as (...a: unknown[]) => unknown;
    const desviar = (sql: string) =>
      /from\s+tenants\b/i.test(sql) ? sql.replace(/\btenants\b/g, 'tenants_que_no_existe') : sql;
    return new Proxy(cliente, {
      get(destino, prop, receptor) {
        if (prop !== 'query') return Reflect.get(destino, prop, receptor);
        return (...args: unknown[]) => {
          const [texto, ...resto] = args;
          if (typeof texto === 'string') return consultar(desviar(texto), ...resto);
          const config = texto as { text?: unknown } | null;
          if (config && typeof config.text === 'string') {
            return consultar({ ...config, text: desviar(config.text) }, ...resto);
          }
          return consultar(...args);
        };
      },
    });
  }

  it('degrada a la zona del producto y la transacción queda usable', async () => {
    olvidarZonas();
    const avisos: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void avisos.push(a.map(String).join(' '));

    try {
      const resultado = await withTenant(admin, chileno, async (c) => {
        const zona = await zonaDelTenant(clienteSinTenants(c), chileno);
        // Lo que de verdad prueba esto: después del fallo, el llamador puede
        // seguir consultando. Con el `.catch()` de antes, acá llegaba
        // `current transaction is aborted`.
        const sigue = await c.query('SELECT 1 AS vivo');
        return { zona, vivo: sigue.rows[0].vivo };
      });

      expect(resultado.zona).toBe('America/Santiago');
      expect(resultado.vivo).toBe(1);
    } finally {
      console.warn = warn;
    }

    // Y el motivo real se dice: sin esto, degradar es esconder.
    expect(avisos.join('\n')).toMatch(/tenants_que_no_existe/);
    expect(avisos.join('\n')).toContain(chileno);
  });

  it('un fallo no se queda cacheado: la próxima vuelve a preguntar', async () => {
    olvidarZonas();
    const warn = console.warn;
    console.warn = () => {};
    try {
      await withTenant(admin, mexicano, (c) => zonaDelTenant(clienteSinTenants(c), mexicano));
      // Con el cliente sano, la zona de verdad. Si el fallo se hubiera
      // cacheado, acá seguiría contestando la del producto por cinco minutos.
      const buena = await withTenant(admin, mexicano, (c) => zonaDelTenant(c, mexicano));
      expect(buena).toBe('America/Mexico_City');
    } finally {
      console.warn = warn;
    }
  });
});
