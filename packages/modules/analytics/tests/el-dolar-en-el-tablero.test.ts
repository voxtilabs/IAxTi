import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { getDashboard } from '../application/dashboard';

/**
 * Los costos del tablero, en pesos y con el dólar de cada día (#796).
 *
 * Lo que esta prueba cuida es que la conversión sea DÍA POR DÍA. Convertir el
 * total con un solo cambio da un número parecido —y por eso es peligroso—:
 * parece bien hasta que el dólar se mueve, y entonces el mismo mes rinde
 * distinto según el día en que se abra el panel.
 *
 * Los números están elegidos para que las dos aritméticas NO coincidan:
 *
 *     día 1:  10 USD × 900 = 9.000
 *     día 2:  10 USD × 1.000 = 10.000     →  por día: 19.000
 *     total: 20 USD × (900 ó 1.000)       →  18.000 ó 20.000
 *
 * Si alguien «simplifica» a `SUM(value) * un_dólar`, el 19.000 se cae.
 */
let pool: Pool;
let tenant: string;
const TOTAL = '00000000-0000-0000-0000-000000000000';
const DIA1 = '2026-04-06';
const DIA2 = '2026-04-07';

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (
    await pool.query("INSERT INTO tenants (name) VALUES ('dolar-en-el-tablero') RETURNING id")
  ).rows[0].id;
  await pool.query(
    `INSERT INTO fx_rates (pair, day, value, source) VALUES
       ('USD/CLP', $1::date, 900, 'prueba'), ('USD/CLP', $2::date, 1000, 'prueba')
     ON CONFLICT (pair, day) DO UPDATE SET value = EXCLUDED.value`,
    [DIA1, DIA2],
  );
  await withTenant(pool, tenant, async (c) => {
    for (const [day, metric, value] of [
      [DIA1, 'costo_meta_usd', 10],
      [DIA2, 'costo_meta_usd', 10],
      [DIA1, 'ia_costo_usd', 2],
      // El día 3 no tiene dólar: el Banco Central no publica todos los días.
      ['2026-04-08', 'ia_costo_usd', 5],
    ] as const) {
      await c.query(
        `INSERT INTO daily_metrics (tenant_id, day, metric, value, owner_id)
              VALUES ($1, $2::date, $3, $4, $5)
         ON CONFLICT (tenant_id, day, metric, owner_id) DO UPDATE SET value = EXCLUDED.value`,
        [tenant, day, metric, value, TOTAL],
      );
    }
  });
});

afterAll(async () => {
  await pool.query("DELETE FROM fx_rates WHERE source = 'prueba'");
  await pool.query('DELETE FROM daily_metrics WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await pool.end();
});

const tablero = () =>
  withTenant(pool, tenant, (c) =>
    getDashboard(c, { tenantId: tenant, from: DIA1, to: '2026-04-08' }),
  );

it('convierte cada día con SU dólar, no el total con uno', async () => {
  const d = await tablero();
  // 10×900 + 10×1.000, y no 20×900 ni 20×1.000.
  expect(d.costos.meta.clp).toBe(19_000);
  expect(d.costos.meta.usd).toBe(20);
  expect(d.costos.meta.diasSinCambio).toBe(0);
});

it('el día sin dólar no se convierte con el de otra fecha: se cuenta y se dice', async () => {
  const d = await tablero();
  // 2 USD del día 1 a 900 = 1.800. Los 5 USD del día sin cambio NO se suman
  // con el dólar de otro día: quedan afuera y contados.
  expect(d.costos.ia.clp).toBe(1_800);
  expect(d.costos.ia.usd).toBe(7);
  expect(d.costos.ia.diasSinCambio).toBe(1);
});

it('los dólares siguen estando, que es con lo que se cuadra la factura de Meta', async () => {
  const d = await tablero();
  expect(d.metrics.costo_meta_usd).toBe(20);
  expect(d.metrics.ia_costo_usd).toBe(7);
});

it('sin NINGÚN dólar en el rango, clp es null y no cero', async () => {
  // Cero es «no gastó» y null es «no sabemos cuánto es en pesos». Un panel que
  // los muestra igual le dice al negocio que no gastó nada.
  const d = await withTenant(pool, tenant, (c) =>
    getDashboard(c, { tenantId: tenant, from: '2026-04-08', to: '2026-04-08' }),
  );
  expect(d.costos.ia.clp).toBeNull();
  expect(d.costos.ia.usd).toBe(5);
  expect(d.costos.ia.diasSinCambio).toBe(1);
});
