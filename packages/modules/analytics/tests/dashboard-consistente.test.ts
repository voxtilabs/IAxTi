import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { getDashboard } from '../application/dashboard';
import { METRICS, TOTAL_OWNER } from '../domain/metrics';

const pool = createPool(process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti');
const tenant = randomUUID(), otro = randomUUID(), owner = randomUUID();
const rol = `reporte_${randomUUID().replaceAll('-', '')}`;
const rango = { from: '2026-09-01', to: '2026-09-03' };

beforeAll(async () => {
  await runMigrations(pool);
  await pool.query(`CREATE ROLE "${rol}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO "${rol}"`);
  await pool.query(`GRANT SELECT ON daily_metrics, response_samples, conversations TO "${rol}"`);
  await pool.query('INSERT INTO tenants(id,name) VALUES ($1,$3),($2,$3)', [tenant, otro, 'Reporte consistente']);
  for (const [t, day, metric, value, o] of [
    [tenant, '2026-08-31', 'conversaciones_nuevas', 90, TOTAL_OWNER],
    [tenant, '2026-09-01', 'conversaciones_nuevas', 5, TOTAL_OWNER],
    [tenant, '2026-09-01', 'resueltas', 2, TOTAL_OWNER],
    [tenant, '2026-09-01', 'resueltas', 1, owner],
    [tenant, '2026-09-03', 'conversaciones_nuevas', 7, TOTAL_OWNER],
    [tenant, '2026-09-02', 'ia_costo_usd', 0.0123, TOTAL_OWNER],
    [tenant, '2026-09-03', 'ganadas', 2, TOTAL_OWNER],
    [tenant, '2026-09-03', 'perdidas', 1, TOTAL_OWNER],
    [tenant, '2026-09-03', 'valor_ganado_clp', 987654321.125, TOTAL_OWNER],
    [tenant, '2026-09-04', 'resueltas', 88, TOTAL_OWNER],
    [otro, '2026-09-01', 'conversaciones_nuevas', 999, TOTAL_OWNER],
  ]) await pool.query('INSERT INTO daily_metrics(tenant_id,day,metric,value,owner_id) VALUES($1,$2,$3,$4,$5)', [t, day, metric, value, o]);
  for (const [t, seconds, o, day] of [[tenant, 10, owner, '2026-09-01'], [tenant, 61, owner, '2026-09-03'], [tenant, 180, null, '2026-09-02'], [tenant, 999, owner, '2026-08-31'], [otro, 9999, owner, '2026-09-02']]) {
    await pool.query('INSERT INTO response_samples(tenant_id,conversation_id,owner_id,day,seconds) VALUES($1,$2,$3,$4,$5)', [t, randomUUID(), o, day, seconds]);
  }
});
afterAll(async () => {
  for (const table of ['daily_metrics', 'response_samples']) await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [[tenant, otro]]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[tenant, otro]]);
  await pool.query(`REVOKE SELECT ON daily_metrics, response_samples, conversations FROM "${rol}"`);
  await pool.query(`REVOKE USAGE ON SCHEMA public FROM "${rol}"`);
  await pool.query(`DROP ROLE "${rol}"`);
  await pool.end();
});

describe('dashboard en una lectura (#424)', () => {
  it('suma una vez, preserva decimales y devuelve la serie en orden, incluidos días solo con costos', async () => {
    const r = await withTenant(pool, tenant, async (client) => {
      const query = vi.spyOn(client, 'query');
      try {
        const value = await getDashboard(client, { tenantId: tenant, ...rango });
        expect(query).toHaveBeenCalledTimes(1);
        return value;
      } finally { query.mockRestore(); }
    });
    expect(r.metrics.conversaciones_nuevas).toBe(12);
    expect(r.metrics.resueltas).toBe(2);
    expect(r.metrics.ia_costo_usd).toBe(0.0123);
    expect(r.metrics.valor_ganado_clp).toBe(987654321.125);
    expect(r.tasaCierre).toBe(0.667);
    expect(r.primeraRespuesta).toEqual({ muestras: 3, medianaSeg: 61, p90Seg: 156 });
    expect(r.porDia).toEqual([
      { day: '2026-09-01', conversaciones: 5, resueltas: 2, oportunidades: 0 },
      { day: '2026-09-02', conversaciones: 0, resueltas: 0, oportunidades: 0 },
      { day: '2026-09-03', conversaciones: 7, resueltas: 0, oportunidades: 0 },
    ]);
  });
  it('filtra el usuario tanto en contadores como en muestras', async () => {
    const r = await withTenant(pool, tenant, (client) => getDashboard(client, { tenantId: tenant, ownerId: owner, ...rango }));
    expect(r.metrics.resueltas).toBe(1);
    expect(r.metrics.conversaciones_nuevas).toBe(0);
    expect(r.primeraRespuesta).toEqual({ muestras: 2, medianaSeg: 36, p90Seg: 56 });
    expect(r.porDia).toEqual([{ day: '2026-09-01', conversaciones: 0, resueltas: 1, oportunidades: 0 }]);
  });
  it('RLS sigue protegiendo todos los subresultados aunque se pida otro tenant', async () => {
    await withTenant(pool, tenant, async (client) => {
      await client.query(`SET LOCAL ROLE "${rol}"`);
      const propio = await getDashboard(client, { tenantId: tenant, ...rango });
      expect(propio.metrics.conversaciones_nuevas).toBe(12);
      const ajeno = await getDashboard(client, { tenantId: otro, ...rango });
      expect(ajeno.metrics.conversaciones_nuevas).toBe(0);
      expect(ajeno.porDia).toEqual([]);
      expect(ajeno.primeraRespuesta.muestras).toBe(0);
      expect(ajeno.sinResponderAhora).toBe(0);
    });
  });
  it('el vacío conserva todos los campos y no fabrica percentiles ni cierre', async () => {
    const r = await withTenant(pool, tenant, (client) => getDashboard(client, { tenantId: tenant, from: '2025-01-01', to: '2025-01-02' }));
    expect(r.metrics).toEqual(Object.fromEntries(METRICS.map((m) => [m, 0])));
    expect(r.porDia).toEqual([]);
    expect(r.primeraRespuesta).toEqual({ muestras: 0, medianaSeg: null, p90Seg: null });
    expect(r.tasaCierre).toBeNull();
  });
});
