import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import {
  accesoAlModulo,
  createTenant,
  modulosDelPlan,
  modulosVendibles,
  olvidarPlanes,
  PLAN_UNICO,
} from '@iaxti/module-organizations';

/**
 * Un solo plan con todo (#1377, ADR-0036).
 *
 * Decisión del dueño: «quiero eliminar por ahora lo de los planes; que IAxTi
 * tenga estas cosas, que trae y ya». Lo que se prueba acá es lo que esa frase
 * promete, contra Postgres real y por la MISMA función con la que el guard
 * decide (`accesoAlModulo`): ningún negocio queda con un módulo en solo
 * lectura, venga del plan que venga.
 *
 * La migración se vuelve a aplicar sobre negocios puestos a mano en los planes
 * viejos: `runMigrations` ya la corrió en una base donde quizás no había
 * ninguno, y la promesa es para los que YA existían.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const MIGRACION = readFileSync(
  join(__dirname, '../../../packages/modules/platform/migrations/0006_un_solo_plan.sql'),
  'utf8',
);
const LOS_NUEVE = [
  'crm', 'conversations', 'agents', 'calendar', 'payments',
  'automations', 'knowledge', 'integrations', 'analytics',
];

let admin: Pool;
const viejos: Record<string, string> = {};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  // Un negocio en cada plan viejo, como quedaron los que ya existían.
  for (const plan of ['base', 'crece', 'equipo']) {
    const r = await admin.query(
      `INSERT INTO tenants (name, plan, state) VALUES ($1, $2, 'active') RETURNING id`,
      [`un-solo-plan ${plan}`, plan],
    );
    viejos[plan] = r.rows[0].id as string;
  }
  await admin.query(MIGRACION);
  olvidarPlanes();
});

afterAll(async () => {
  await admin?.end();
});

describe('un solo plan con todo (#1377)', () => {
  it('el plan único trae los nueve módulos que se venden', async () => {
    const r = await admin.query(`SELECT modules FROM plan_limits WHERE plan = $1`, [PLAN_UNICO]);
    expect([...(r.rows[0].modules as string[])].sort()).toEqual([...LOS_NUEVE].sort());
  });

  it('un negocio de cualquier plan viejo tiene TODO en completo', async () => {
    const vendibles = await modulosVendibles(admin);
    for (const [planViejo, id] of Object.entries(viejos)) {
      const plan = await modulosDelPlan(admin, id);
      expect(plan.plan, `el de ${planViejo} pasó al plan único`).toBe(PLAN_UNICO);
      for (const moduleId of LOS_NUEVE) {
        expect(
          accesoAlModulo({ moduleId, vendibles, delPlan: plan.modulos }),
          `${moduleId} para el que venía de ${planViejo}`,
        ).toBe('completo');
      }
    }
  });

  it('un negocio nuevo nace en el plan único', async () => {
    const c = await admin.connect();
    try {
      const nuevo = await createTenant(c, { name: 'un-solo-plan nace' });
      expect(nuevo.plan).toBe(PLAN_UNICO);
    } finally {
      c.release();
    }
  });

  it('y aunque alguien inserte a mano sin plan, la columna nace en el plan único', async () => {
    const r = await admin.query(
      `INSERT INTO tenants (name, state) VALUES ('un-solo-plan sin plan', 'active') RETURNING plan`,
    );
    expect(r.rows[0].plan).toBe(PLAN_UNICO);
  });

  it('los topes siguen ahí: quedan como freno de seguridad, no desaparecen', async () => {
    const r = await admin.query(
      `SELECT whatsapp_numbers, conversations_month, ia_executions_month, api_requests_month
         FROM plan_limits WHERE plan = $1`,
      [PLAN_UNICO],
    );
    expect(r.rows[0]).toEqual({
      whatsapp_numbers: 5,
      conversations_month: 8000,
      ia_executions_month: 12000,
      api_requests_month: 200000,
    });
  });

  it('los planes viejos siguen en la tabla: volver es cambiar el plan de los negocios', async () => {
    const r = await admin.query(`SELECT plan FROM plan_limits WHERE plan IN ('base','crece','equipo')`);
    expect(r.rowCount).toBe(3);
  });
});
