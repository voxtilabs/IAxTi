import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { getTenant } from '@iaxti/module-organizations';
import { cancelarSuscripcion, sweepBilling } from '../application/billing';

/**
 * Cancelar en un clic (SPEC §6): «con exportación completa antes».
 *
 * No existía ninguna de las dos cosas. La exportación llegó en #222 y esto
 * es la otra mitad — y lo que se prueba acá es sobre todo que no se pueda
 * cancelar sin haberle entregado al negocio lo suyo.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const duena = randomUUID();

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan, state) VALUES ('cancelacion-test', 'crece', 'active') RETURNING id",
  );
  tenant = t.rows[0].id;
  await admin.query(
    `INSERT INTO subscriptions (tenant_id, plan, status, cycle_start, next_charge_at)
     VALUES ($1, 'crece', 'active', now()::date, now()::date + 12)`,
    [tenant],
  );
});

afterAll(async () => {
  await admin.query('DELETE FROM subscriptions WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

describe('cancelar en un clic', () => {
  it('sin exportación no se cancela: la ley del §6 no es un consejo al frontend', async () => {
    await expect(
      withTenant(admin, tenant, (c) =>
        cancelarSuscripcion(c, {
          tenantId: tenant,
          actor: duena,
          exportacion: undefined as never,
        }),
      ),
    ).rejects.toThrow(/exportación completa/);
  });

  it('cancela al final del ciclo PAGADO, no en el acto', async () => {
    const { cancelAt } = await withTenant(admin, tenant, (c) =>
      cancelarSuscripcion(c, {
        tenantId: tenant,
        actor: duena,
        motivo: 'se va a otro sistema',
        exportacion: { filas: 1234, generadoEl: '2026-09-15T00:00:00.000Z' },
      }),
    );
    // La fecha es el próximo cobro: lo pagado se usa.
    expect(cancelAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Y el negocio sigue trabajando igual hasta entonces.
    expect((await withTenant(admin, tenant, (c) => getTenant(c, tenant))).state).toBe('active');

    const audit = await admin.query(
      `SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'billing.suscripcion.cancelada'
        ORDER BY id DESC LIMIT 1`,
      [tenant],
    );
    // Queda escrito CUÁNTO se llevó: es la prueba de que se le entregó.
    expect(audit.rows[0].metadata.exportacion.filas).toBe(1234);
    expect(audit.rows[0].metadata.motivo).toBe('se va a otro sistema');
  });

  it('cumplida la fecha, el barrido la deja en solo lectura', async () => {
    await admin.query(
      "UPDATE subscriptions SET cancel_at = now()::date - 1 WHERE tenant_id = $1",
      [tenant],
    );
    const res = await sweepBilling(admin);
    expect(res.cancelacionesEfectivas).toBeGreaterThanOrEqual(1);
    expect((await withTenant(admin, tenant, (c) => getTenant(c, tenant))).state).toBe('read_only');
  });

  it('no se cancela dos veces', async () => {
    await expect(
      withTenant(admin, tenant, (c) =>
        cancelarSuscripcion(c, {
          tenantId: tenant,
          actor: duena,
          exportacion: { filas: 1, generadoEl: '2026-09-15T00:00:00.000Z' },
        }),
      ),
    ).rejects.toThrow(/suscripción activa/);
  });
});
