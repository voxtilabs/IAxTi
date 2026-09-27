import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';

/**
 * Ningún `DELETE FROM payment_links` funcionaba, y en silencio (#625).
 *
 * `payment_links_immutable()` hacía `RETURN NEW` en un trigger
 * `BEFORE UPDATE OR DELETE`. En un DELETE, `NEW` es NULL, y un trigger BEFORE
 * que devuelve NULL **cancela la operación sin error**: el DELETE reporta cero
 * filas afectadas, exactamente igual que si la fila no existiera.
 *
 * Lo peor no es que no borre: es que **no se queja**. La limpieza de los tests
 * creía que borró, la base compartida de desarrollo acumula filas de cada
 * corrida, y el día que la retención del §39 tenga que borrar un link no va a
 * borrar nada y va a decir que sí.
 *
 * La intención del trigger no está en discusión y no cambia: un link pagado es
 * la constancia de que alguien pagó y no se toca. Lo que se arregla es que el
 * mismo `RETURN` servía para dos operaciones donde significa cosas opuestas.
 */

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let proveedor: string;

/** Un link con el estado que pida, sin pasar por el caso de uso. */
async function nuevoLink(status: string): Promise<string> {
  const r = await withTenant(admin, tenant, (c) =>
    c.query(
      `INSERT INTO payment_links (tenant_id, provider_id, contact_id, amount_clp, concept, expires_at, status)
       VALUES ($1,$2,NULL,$3,$4, now() + interval '72 hours', $5) RETURNING id`,
      [tenant, proveedor, 12_000, 'Corte de pelo', status],
    ),
  );
  return r.rows[0].id as string;
}

async function cuantos(id: string): Promise<number> {
  const r = await withTenant(admin, tenant, (c) =>
    c.query('SELECT count(*)::int AS n FROM payment_links WHERE tenant_id = $1 AND id = $2', [
      tenant,
      id,
    ]),
  );
  return r.rows[0].n as number;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('borrar-link') RETURNING id"))
    .rows[0].id;
  proveedor = (
    await withTenant(admin, tenant, (c) =>
      c.query(
        `INSERT INTO payment_providers (tenant_id, kind, name, mode, credential_ref, active)
         VALUES ($1,'simulado','Simulador','test','SIM_CRED',true) RETURNING id`,
        [tenant],
      ),
    )
  ).rows[0].id;
});

afterAll(async () => {
  await withTenant(admin, tenant, (c) =>
    c.query('DELETE FROM payment_links WHERE tenant_id = $1', [tenant]),
  );
  await admin.query('DELETE FROM payment_providers WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('borrar un link de pago (#625)', () => {
  it('un link que NO está pagado se borra de verdad', async () => {
    const id = await nuevoLink('sent');
    const r = await withTenant(admin, tenant, (c) =>
      c.query('DELETE FROM payment_links WHERE tenant_id = $1 AND id = $2', [tenant, id]),
    );
    // Lo que fallaba: rowCount 0 y la fila seguía ahí, sin un error que mirar.
    expect(r.rowCount, 'el DELETE dijo que no borró nada').toBe(1);
    expect(await cuantos(id), 'el DELETE dijo que borró y la fila sigue ahí').toBe(0);
  });

  it('un link PAGADO se niega EN VOZ ALTA, no cancelando en silencio', async () => {
    const id = await nuevoLink('paid');
    await expect(
      withTenant(admin, tenant, (c) =>
        c.query('DELETE FROM payment_links WHERE tenant_id = $1 AND id = $2', [tenant, id]),
      ),
    ).rejects.toThrow(/inmutable/i);
    expect(await cuantos(id)).toBe(1);
    // Se limpia por fuera del trigger, que es lo único que puede.
    await admin.query('ALTER TABLE payment_links DISABLE TRIGGER payment_links_immutable_trg');
    await admin.query('DELETE FROM payment_links WHERE id = $1', [id]);
    await admin.query('ALTER TABLE payment_links ENABLE TRIGGER payment_links_immutable_trg');
  });

  it('el UPDATE de un link pagado sigue prohibido: eso no cambió', async () => {
    const id = await nuevoLink('paid');
    await expect(
      withTenant(admin, tenant, (c) =>
        c.query('UPDATE payment_links SET concept = $3 WHERE tenant_id = $1 AND id = $2', [
          tenant,
          id,
          'otro',
        ]),
      ),
    ).rejects.toThrow(/inmutable/i);
    await admin.query('ALTER TABLE payment_links DISABLE TRIGGER payment_links_immutable_trg');
    await admin.query('DELETE FROM payment_links WHERE id = $1', [id]);
    await admin.query('ALTER TABLE payment_links ENABLE TRIGGER payment_links_immutable_trg');
  });

  it('y el UPDATE de uno no pagado sigue funcionando', async () => {
    const id = await nuevoLink('sent');
    const r = await withTenant(admin, tenant, (c) =>
      c.query('UPDATE payment_links SET concept = $3 WHERE tenant_id = $1 AND id = $2', [
        tenant,
        id,
        'Corte y barba',
      ]),
    );
    expect(r.rowCount).toBe(1);
  });
});
