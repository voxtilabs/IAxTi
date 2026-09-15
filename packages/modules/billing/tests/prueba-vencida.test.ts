import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { getTenant } from '@iaxti/module-organizations';
import { sweepBilling } from '../application/billing';

/**
 * La prueba gratis termina (SPEC §6).
 *
 * `trial_ends_at` se escribía al crear el tenant, se mostraba en el panel y
 * el SuperAdmin la podía extender. Nadie actuaba sobre ella: la prueba de
 * 14 días duraba para siempre, con los módulos de Crece regalados.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let vencido: string;
let pagador: string;
let alDia: string;

const nuevoTenant = async (nombre: string, dias: number) => {
  const t = await admin.query(
    `INSERT INTO tenants (name, plan, state, trial_ends_at)
     VALUES ($1, 'crece', 'trial', now() + make_interval(days => $2)) RETURNING id`,
    [nombre, dias],
  );
  return t.rows[0].id as string;
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  vencido = await nuevoTenant('prueba-vencida', -1);
  pagador = await nuevoTenant('prueba-convertida', -1);
  alDia = await nuevoTenant('prueba-en-curso', 5);
  await admin.query(
    `INSERT INTO subscriptions (tenant_id, plan, status, next_charge_at)
     VALUES ($1, 'crece', 'active', now()::date + 30)`,
    [pagador],
  );
});

afterAll(async () => {
  for (const t of [vencido, pagador, alDia]) {
    await admin.query('DELETE FROM subscriptions WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [t]);
  }
  await admin.end();
});

describe('la prueba de 14 días se acaba', () => {
  it('vencida sin suscripción: queda en solo lectura y vuelve al plan base', async () => {
    const res = await sweepBilling(admin);
    expect(res.trialsVencidas).toBeGreaterThanOrEqual(2);

    const t = await withTenant(admin, vencido, (c) => getTenant(c, vencido));
    expect(t.state).toBe('read_only');
    // Los módulos de Crece eran de la prueba, no del plan.
    expect(t.plan).toBe('base');
  });

  it('vencida CON suscripción viva: pasa a activo y conserva su plan', async () => {
    const t = await withTenant(admin, pagador, (c) => getTenant(c, pagador));
    expect(t.state).toBe('active');
    expect(t.plan).toBe('crece');
  });

  it('la prueba en curso no se toca', async () => {
    const t = await withTenant(admin, alDia, (c) => getTenant(c, alDia));
    expect(t.state).toBe('trial');
    expect(t.plan).toBe('crece');
  });

  it('el barrido no la vence dos veces', async () => {
    const res = await sweepBilling(admin);
    const t = await withTenant(admin, vencido, (c) => getTenant(c, vencido));
    expect(t.state).toBe('read_only');
    expect(res.trialsVencidas).toBe(0);
  });
});
