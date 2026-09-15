import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  guardarRespuesta,
  huellaDelPedido,
  limpiarLlavesVencidas,
  reservarLlave,
  soltarLlave,
} from '../src/idempotencia';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('idem-core') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.query('DELETE FROM idempotency_keys WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

const pedido = (key: string, body: unknown = { a: 1 }) => ({
  tenantId: tenant,
  key,
  method: 'POST',
  path: '/v1/deals',
  body,
});

describe('idempotencia (SPEC §28)', () => {
  it('cuerpo vacío y ausente tienen la misma huella; cuerpos distintos, distinta', () => {
    expect(huellaDelPedido(undefined)).toBe(huellaDelPedido(null));
    expect(huellaDelPedido({ a: 1 })).not.toBe(huellaDelPedido({ a: 2 }));
  });

  it('reserva → en curso → repetida, con la respuesta guardada tal cual', async () => {
    const key = 'k-flujo';
    expect((await withTenant(admin, tenant, (c) => reservarLlave(c, pedido(key)))).estado).toBe('nueva');
    // Todavía sin responder: un segundo intento NO debe ejecutar nada.
    expect((await withTenant(admin, tenant, (c) => reservarLlave(c, pedido(key)))).estado).toBe('en_curso');

    await withTenant(admin, tenant, (c) =>
      guardarRespuesta(c, { tenantId: tenant, key, status: 201, body: { id: 'deal-1' } }),
    );
    const repetida = await withTenant(admin, tenant, (c) => reservarLlave(c, pedido(key)));
    expect(repetida.estado).toBe('repetida');
    expect(repetida.respuesta).toEqual({ status: 201, body: { id: 'deal-1' } });
  });

  it('la misma llave con otro cuerpo, otro método u otra ruta es conflicto', async () => {
    const key = 'k-conflicto';
    await withTenant(admin, tenant, (c) => reservarLlave(c, pedido(key)));
    const otroCuerpo = await withTenant(admin, tenant, (c) => reservarLlave(c, pedido(key, { a: 99 })));
    expect(otroCuerpo.estado).toBe('conflicto');
    const otraRuta = await withTenant(admin, tenant, (c) =>
      reservarLlave(c, { ...pedido(key), path: '/v1/payments/links' }),
    );
    expect(otraRuta.estado).toBe('conflicto');
  });

  it('soltar la llave devuelve el pedido al principio', async () => {
    const key = 'k-soltada';
    await withTenant(admin, tenant, (c) => reservarLlave(c, pedido(key)));
    await withTenant(admin, tenant, (c) => soltarLlave(c, { tenantId: tenant, key }));
    expect((await withTenant(admin, tenant, (c) => reservarLlave(c, pedido(key)))).estado).toBe('nueva');
  });

  it('las llaves vencen a las 24 h; las de hoy no se tocan', async () => {
    await withTenant(admin, tenant, (c) => reservarLlave(c, pedido('k-vieja')));
    await admin.query(
      "UPDATE idempotency_keys SET created_at = now() - interval '2 days' WHERE tenant_id = $1 AND key = 'k-vieja'",
      [tenant],
    );
    await withTenant(admin, tenant, (c) => reservarLlave(c, pedido('k-nueva')));

    const borradas = await withTenant(admin, tenant, (c) => limpiarLlavesVencidas(c));
    expect(borradas).toBeGreaterThanOrEqual(1);
    const quedan = await admin.query('SELECT key FROM idempotency_keys WHERE tenant_id = $1', [tenant]);
    const llaves = quedan.rows.map((r) => r.key);
    expect(llaves).toContain('k-nueva');
    expect(llaves).not.toContain('k-vieja');
  });
});
