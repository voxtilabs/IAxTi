import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { changeTenantState, getTenant } from '@iaxti/module-organizations';
import { sweepBilling } from '../application/billing';

/**
 * Treinta días en solo lectura y la cuenta se suspende (SPEC §6).
 *
 * La transición existía solo a mano, desde el panel del SuperAdmin, y el
 * plazo no lo contaba nadie — ni había desde cuándo contarlo: `state_since`
 * no existía.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let viejo: string;
let reciente: string;

const enSoloLectura = async (nombre: string, diasAtras: number) => {
  const t = await admin.query(
    `INSERT INTO tenants (name, plan, state, state_since)
     VALUES ($1, 'base', 'read_only', now() - make_interval(days => $2)) RETURNING id`,
    [nombre, diasAtras],
  );
  return t.rows[0].id as string;
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  viejo = await enSoloLectura('solo-lectura-viejo', 31);
  reciente = await enSoloLectura('solo-lectura-reciente', 10);
});

afterAll(async () => {
  for (const t of [viejo, reciente]) {
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [t]);
  }
  await admin.end();
});

describe('la suspensión a los 30 días', () => {
  it('suspende al que lleva 31 días y no toca al de 10', async () => {
    await sweepBilling(admin);

    expect((await withTenant(admin, viejo, (c) => getTenant(c, viejo))).state).toBe('suspended');
    expect((await withTenant(admin, reciente, (c) => getTenant(c, reciente))).state).toBe('read_only');
  });

  it('no lo suspende dos veces', async () => {
    await sweepBilling(admin);
    expect((await withTenant(admin, viejo, (c) => getTenant(c, viejo))).state).toBe('suspended');
  });

  it('el reloj se reinicia con cada cambio de estado', async () => {
    const antes = await withTenant(admin, reciente, (c) => getTenant(c, reciente));
    await withTenant(admin, reciente, (c) => changeTenantState(c, reciente, 'active'));
    const despues = await withTenant(admin, reciente, (c) => getTenant(c, reciente));
    expect(despues.stateSince!.getTime()).toBeGreaterThan(antes.stateSince!.getTime());
  });
});
