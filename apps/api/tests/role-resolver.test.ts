import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import { dbCustomPermissionsResolver, dbRoleResolver } from '../src/auth/role-resolver';

// El id del tenant llega en una cabecera: cualquiera puede mandar cualquier
// cosa. Con base configurada —o sea, en staging y producción— un id que no era
// uuid reventaba la consulta de roles custom (#152) y salía un 500 donde
// corresponde un 403. El CI no lo veía porque turbo no propaga DATABASE_URL a
// los tests: sin pool, el resolver ni se arma.

const URL_BASE = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let pool: Pool;

beforeAll(async () => {
  pool = createPool(URL_BASE);
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('resolvers de rol con un tenant inválido', () => {
  it('un tenant que no es uuid niega, no revienta', async () => {
    const rol = dbRoleResolver(pool);
    await expect(rol('t-1', 'u-1')).resolves.toBeNull();

    const permisos = dbCustomPermissionsResolver(pool);
    await expect(permisos('t-1', 'CONTADOR')).resolves.toBeNull();
    await expect(permisos('', 'CONTADOR')).resolves.toBeNull();
    await expect(permisos("'; DROP TABLE tenants; --", 'CONTADOR')).resolves.toBeNull();
  });

  it('un uuid bien formado sí consulta la base (y no encuentra nada)', async () => {
    const permisos = dbCustomPermissionsResolver(pool);
    await expect(permisos('00000000-0000-0000-0000-000000000000', 'CONTADOR')).resolves.toBeNull();
  });
});
