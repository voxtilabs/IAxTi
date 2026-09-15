import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createPool } from '../src/client';
import { runMigrations } from '../src/migrate';

/**
 * El inventario de datos personales no puede quedar desactualizado en
 * silencio (Ley 21.719, registro de actividades de tratamiento).
 *
 * Una tabla nueva con `tenant_id` guarda algo de alguien. Si nadie dice qué,
 * el inventario deja de servir justo cuando se lo piden — y se lo piden
 * cuando ya no hay tiempo de averiguarlo.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const INVENTARIO = join(__dirname, '../../../docs/INVENTARIO-DATOS.md');

let admin: Pool;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
});

afterAll(async () => {
  await admin.end();
});

describe('inventario de datos personales', () => {
  it('toda tabla con tenant_id está inventariada', async () => {
    const texto = readFileSync(INVENTARIO, 'utf8');
    const r = await admin.query(
      `SELECT DISTINCT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'
        ORDER BY table_name`,
    );
    const tablas = r.rows.map((x) => x.table_name as string);
    expect(tablas.length).toBeGreaterThan(30);

    // La tabla se nombra entre acentos graves en alguna fila del documento.
    const faltan = tablas.filter((t) => !texto.includes(`\`${t}\``));
    expect(
      faltan,
      `Estas tablas guardan datos de un tenant y no están en docs/INVENTARIO-DATOS.md:\n  ${faltan.join('\n  ')}\n` +
        'Decir qué guardan es parte de agregarlas.',
    ).toEqual([]);
  });

  it('`tenants` también está, aunque no tenga tenant_id', () => {
    const texto = readFileSync(INVENTARIO, 'utf8');
    expect(texto).toContain('`tenants`');
  });
});
