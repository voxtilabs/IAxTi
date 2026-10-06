import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createContact } from '@iaxti/module-crm';
import { exportarContactos } from '@iaxti/module-crm';

/**
 * La exportación a Excel, abierta por un lector de verdad (#709).
 *
 * La prueba que importa no es ninguna aserción mía sobre el XML: es que el
 * archivo que sale de la ruta lo ABRA `openpyxl`, que no sabe nada de este
 * código. Si no lo abre, el formato está mal y da igual que mis pruebas pasen.
 *
 * Y comprueba lo que motivó el issue: en CSV, `+56981234567` se abre como
 * 5,6981E+10 y un RUT con guion se lee como una resta. El negocio concluye que
 * perdimos su información, y tiene razón en concluirlo.
 */
let pool: Pool;
let tenant: string;
const directorio = mkdtempSync(join(tmpdir(), 'iaxti-export-'));

const hayOpenpyxl =
  spawnSync('python3', ['-c', 'import openpyxl'], { encoding: 'utf8' }).status === 0;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants(name) VALUES ('Export xlsx') RETURNING id")).rows[0].id;
  await withTenant(pool, tenant, async (c) => {
    await createContact(c, { tenantId: tenant, phone: '+56981234567', name: 'Carla Pérez', rut: '765432103' });
    await createContact(c, { tenantId: tenant, phone: '+56987654321', name: 'Diego & <Hijos>' });
  });
});
afterAll(async () => {
  rmSync(directorio, { recursive: true, force: true });
  await pool.end();
});

function leerConOpenpyxl(buffer: Buffer): Record<string, { valor: unknown; tipo: string }> {
  const ruta = join(directorio, 'contactos.xlsx');
  writeFileSync(ruta, buffer);
  const guion = `
import json, sys, openpyxl
h = openpyxl.load_workbook(sys.argv[1]).active
celdas = {}
for fila in h.iter_rows():
    for c in fila:
        if c.value is None: continue
        celdas[c.coordinate] = {"valor": c.value.isoformat() if hasattr(c.value, "isoformat") else c.value, "tipo": c.data_type}
print(json.dumps(celdas))
`;
  const r = spawnSync('python3', ['-c', guion, ruta], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openpyxl no pudo abrir la exportación: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe.skipIf(!hayOpenpyxl)('la exportación de contactos a Excel (#709)', () => {
  it('sale una planilla que openpyxl abre, con el encabezado y los contactos', async () => {
    const { xlsx, filas } = await withTenant(pool, tenant, (c) =>
      exportarContactos(c, { tenantId: tenant }),
    );
    expect(filas).toBe(2);
    const celdas = leerConOpenpyxl(xlsx);
    expect(celdas.A1.valor).toBe('nombre');
    expect(celdas.B1.valor).toBe('telefono');
    const nombres = Object.entries(celdas)
      .filter(([ref]) => ref.startsWith('A') && ref !== 'A1')
      .map(([, v]) => v.valor);
    expect(nombres).toContain('Carla Pérez');
  });

  it('el teléfono y el RUT llegan como TEXTO, que es el motivo del issue', async () => {
    const { xlsx } = await withTenant(pool, tenant, (c) => exportarContactos(c, { tenantId: tenant }));
    const celdas = leerConOpenpyxl(xlsx);
    const telefonos = Object.entries(celdas).filter(([ref]) => ref.startsWith('B') && ref !== 'B1');
    expect(telefonos.length).toBeGreaterThan(0);
    for (const [ref, v] of telefonos) {
      // 's' es cadena. Si saliera 'n', Excel lo muestra como 5,6981E+10 — que
      // es exactamente lo que pasa hoy con el CSV.
      expect(v.tipo, `${ref} debería ser texto`).toBe('s');
      expect(String(v.valor)).toMatch(/^\+56/);
    }
  });

  it('un nombre con & y < no deja el archivo sin abrir', async () => {
    // Un ampersand sin escapar deja el XML inválido, y Excel no dice «hay un &
    // en la fila 3»: dice que el archivo está dañado.
    const { xlsx } = await withTenant(pool, tenant, (c) => exportarContactos(c, { tenantId: tenant }));
    const celdas = leerConOpenpyxl(xlsx);
    const valores = Object.values(celdas).map((v) => v.valor);
    expect(valores).toContain('Diego & <Hijos>');
  });

  it('las fechas son fechas, no texto', async () => {
    // `creado` sale de un timestamptz. En CSV iba como ISO y Excel lo dejaba
    // como texto: no se puede ordenar ni filtrar por rango.
    const { xlsx, columnas } = await withTenant(pool, tenant, (c) =>
      exportarContactos(c, { tenantId: tenant }),
    );
    const celdas = leerConOpenpyxl(xlsx);
    const col = String.fromCharCode(65 + columnas.indexOf('creado'));
    expect(celdas[`${col}2`].tipo, 'la columna creado tiene que ser fecha').toBe('d');
  });
});

describe('sin openpyxl no se finge la verificación', () => {
  it('lo dice en vez de pasar en silencio', () => {
    expect(typeof hayOpenpyxl).toBe('boolean');
    if (!hayOpenpyxl) console.warn('openpyxl no está: la exportación NO se verificó con un lector ajeno.');
  });
});
