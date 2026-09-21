import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { METRICS, TOTAL_OWNER } from '../domain/metrics';
import { catalogoDeMetricas, esMetrica, metricaEnRango } from '../application/para-el-asistente';

/**
 * Los números en la forma que necesita un asistente (#410).
 *
 * Lo que se prueba acá es sobre todo lo que NO debe pasar: que el asistente
 * reciba un número sin saber qué significa, o que confunda "no pasó nada"
 * con "nadie midió". Las dos cosas terminan en un modelo inventando.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('asistente-numeros') RETURNING id");
  tenant = t.rows[0].id;
  await admin.query(
    `INSERT INTO daily_metrics (tenant_id, day, metric, owner_id, value) VALUES
       ($1, '2026-09-01', 'ganadas', $2, 3),
       ($1, '2026-09-02', 'ganadas', $2, 4),
       ($1, '2026-09-15', 'ganadas', $2, 10),
       ($1, '2026-09-02', 'valor_ganado_clp', $2, 450000)`,
    [tenant, TOTAL_OWNER],
  );
});

afterAll(async () => {
  await admin.end();
});

const en = <T>(fn: (c: never) => Promise<T>) => withTenant(admin, tenant, fn as never);

describe('los números, para un asistente', () => {
  it('el valor viene con su definición, no solo el número', () => {
    // Un asistente que recibe `ganadas: 7` y después tiene que explicar qué
    // es "ganadas" lo va a inventar. Recibiéndola, la cita.
    return en(async (c) => {
      const r = await metricaEnRango(c, {
        tenantId: tenant, metrica: 'ganadas', desde: '2026-09-01', hasta: '2026-09-30',
      });
      expect(r.valor).toBe(17);
      expect(r.definicion).toMatch(/ganadas/i);
      expect(r.desde).toBe('2026-09-01');
      expect(r.unidad).toBe('cantidad');
    });
  });

  it('respeta el rango, no suma el mes entero', () =>
    en(async (c) => {
      const r = await metricaEnRango(c, {
        tenantId: tenant, metrica: 'ganadas', desde: '2026-09-01', hasta: '2026-09-02',
      });
      expect(r.valor).toBe(7);
    }));

  it('distingue "no pasó nada" de "nadie midió"', () =>
    en(async (c) => {
      // Cero con datos: hubo mediciones y dieron cero en ese rango.
      const vacio = await metricaEnRango(c, {
        tenantId: tenant, metrica: 'ganadas', desde: '2026-01-01', hasta: '2026-01-31',
      });
      expect(vacio.valor).toBe(0);
      expect(vacio.sinDatos).toBe(true);

      const conDatos = await metricaEnRango(c, {
        tenantId: tenant, metrica: 'ganadas', desde: '2026-09-01', hasta: '2026-09-30',
      });
      expect(conDatos.sinDatos).toBe(false);
    }));

  it('la unidad dice cómo leer el número', () =>
    en(async (c) => {
      const plata = await metricaEnRango(c, {
        tenantId: tenant, metrica: 'valor_ganado_clp', desde: '2026-09-01', hasta: '2026-09-30',
      });
      expect(plata.valor).toBe(450000);
      expect(plata.unidad).toBe('pesos');
      const dolares = await metricaEnRango(c, {
        tenantId: tenant, metrica: 'ia_costo_usd', desde: '2026-09-01', hasta: '2026-09-30',
      });
      expect(dolares.unidad).toBe('dolares');
    }));

  it('una métrica inventada falla NOMBRANDO las que existen', () =>
    en(async (c) => {
      // Un modelo que recibe "no existe" a secas vuelve a inventar en el
      // siguiente intento. Con la lista, corrige.
      await expect(
        metricaEnRango(c, {
          tenantId: tenant, metrica: 'ventas_totales', desde: '2026-09-01', hasta: '2026-09-30',
        }),
      ).rejects.toThrow(/No existe.*ganadas/s);
    }));

  it('el tenant de al lado no ve estos números', async () => {
    const otro = (await admin.query("INSERT INTO tenants (name) VALUES ('vecino-numeros') RETURNING id"))
      .rows[0].id as string;
    const r = await withTenant(admin, otro, (c) =>
      metricaEnRango(c, { tenantId: otro, metrica: 'ganadas', desde: '2026-09-01', hasta: '2026-09-30' }),
    );
    expect(r.valor).toBe(0);
    expect(r.sinDatos).toBe(true);
  });

  it('el catálogo trae todas, con definición y unidad', () => {
    const cat = catalogoDeMetricas();
    expect(cat).toHaveLength(METRICS.length);
    for (const m of cat) {
      expect(m.definicion.length, `${m.metrica} sin definición`).toBeGreaterThan(10);
      expect(['cantidad', 'pesos', 'dolares']).toContain(m.unidad);
    }
    expect(esMetrica('ganadas')).toBe(true);
    expect(esMetrica('ventas_totales')).toBe(false);
  });
});
