import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  definirDisponibilidad,
  listarDisponibilidad,
  quitarDisponibilidad,
} from '../application/agenda';

/**
 * Los horarios de atención se podían definir y no se podían ver (#460).
 *
 * `POST /agenda/disponibilidad` existe desde #57 y no la llamaba nadie. Al
 * construirle la pantalla apareció lo que faltaba del otro lado: sin
 * leerlos, cada visita apilaba una franja más sobre las que ya estaban, y
 * la agenda terminaba ofreciendo la misma hora dos veces.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const duena = randomUUID();
// Tipado de verdad y no con `as never` (#507): el casteo era para callar al
// compilador, y callaba TODO el archivo — cada resultado salía `unknown`, así
// que ningún `expect` sobre una propiedad estaba comprobando nada.
const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('horarios-test') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin?.end();
});

describe('horarios de atención', () => {
  it('se leen ordenados por día y hora', async () => {
    await en((c) =>
      definirDisponibilidad(c, { tenantId: tenant, ownerId: duena, weekday: 3, inicioMin: 540, finMin: 720 }),
    );
    await en((c) =>
      definirDisponibilidad(c, { tenantId: tenant, ownerId: duena, weekday: 1, inicioMin: 900, finMin: 1080 }),
    );
    await en((c) =>
      definirDisponibilidad(c, { tenantId: tenant, ownerId: duena, weekday: 1, inicioMin: 540, finMin: 720 }),
    );
    const franjas = await en((c) => listarDisponibilidad(c, { tenantId: tenant, ownerId: duena }));
    expect(franjas.map((f) => `${f.weekday} ${f.inicio}`)).toEqual([
      '1 09:00',
      '1 15:00',
      '3 09:00',
    ]);
  });

  it('dos franjas que se pisan el mismo día se rechazan', async () => {
    // No agregan horas: duplican los huecos que la agenda ofrece, y el
    // cliente ve la misma hora dos veces.
    await expect(
      en((c) =>
        definirDisponibilidad(c, { tenantId: tenant, ownerId: duena, weekday: 1, inicioMin: 660, finMin: 780 }),
      ),
    ).rejects.toThrow(/se pisa/);
  });

  it('el mismo horario en otro día sí se puede', async () => {
    const f = await en((c) =>
      definirDisponibilidad(c, { tenantId: tenant, ownerId: duena, weekday: 6, inicioMin: 540, finMin: 720 }),
    );
    expect(f.weekday).toBe(6);
  });

  it('pegadas, no pisadas: termina a las 12 y la otra empieza a las 12', async () => {
    const f = await en((c) =>
      definirDisponibilidad(c, { tenantId: tenant, ownerId: duena, weekday: 3, inicioMin: 720, finMin: 900 }),
    );
    expect(f.inicio).toBe('12:00');
  });

  it('cada quien ve las suyas', async () => {
    const otra = randomUUID();
    await en((c) =>
      definirDisponibilidad(c, { tenantId: tenant, ownerId: otra, weekday: 1, inicioMin: 540, finMin: 600 }),
    );
    const suyas = await en((c) => listarDisponibilidad(c, { tenantId: tenant, ownerId: otra }));
    expect(suyas).toHaveLength(1);
  });

  it('quitar una franja ajena no hace nada silencioso', async () => {
    const otra = randomUUID();
    const mia = (await en((c) => listarDisponibilidad(c, { tenantId: tenant, ownerId: duena })))[0];
    await expect(
      en((c) => quitarDisponibilidad(c, { tenantId: tenant, ownerId: otra, id: mia.id })),
    ).rejects.toThrow(/no es de esta persona/);
    const siguen = await en((c) => listarDisponibilidad(c, { tenantId: tenant, ownerId: duena }));
    expect(siguen.some((f) => f.id === mia.id)).toBe(true);
  });

  it('quitada, deja de estar', async () => {
    const franjas = await en((c) => listarDisponibilidad(c, { tenantId: tenant, ownerId: duena }));
    await en((c) => quitarDisponibilidad(c, { tenantId: tenant, ownerId: duena, id: franjas[0].id }));
    const quedan = await en((c) => listarDisponibilidad(c, { tenantId: tenant, ownerId: duena }));
    expect(quedan).toHaveLength(franjas.length - 1);
  });
});
