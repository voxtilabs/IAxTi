import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
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
