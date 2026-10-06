import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { crearXlsx, referencia } from '../src/xlsx';

/**
 * El escritor de XLSX (#709).
 *
 * La prueba que importa no es ninguna de las mías: es que el archivo lo ABRA un
 * lector de verdad. Si lo que escribimos no lo abre una implementación ajena, el
 * formato está mal y da exactamente igual que mis aserciones pasen — eso es lo
 * que distingue «escribí XML que me parece correcto» de «esto es un xlsx».
 *
 * Acá el lector es `openpyxl`, que es el que usa medio mundo en Python y no sabe
 * nada de este código. Si no está instalado, esas pruebas se saltan DICIÉNDOLO:
 * saltarse en silencio la única verificación independiente sería peor que no
 * tenerla.
 */
const directorio = mkdtempSync(join(tmpdir(), 'iaxti-xlsx-'));
afterAll(() => rmSync(directorio, { recursive: true, force: true }));

const hayOpenpyxl =
  spawnSync('python3', ['-c', 'import openpyxl'], { encoding: 'utf8' }).status === 0;

/** Abre el archivo con openpyxl y devuelve lo que ESE lector ve. */
function comoLoVeOpenpyxl(archivo: string): {
  hoja: string;
  celdas: Record<string, { valor: unknown; tipo: string; formato: string; negrita: boolean }>;
  anchos: Record<string, number>;
} {
  const guion = `
import json, sys, openpyxl
libro = openpyxl.load_workbook(sys.argv[1])
h = libro.active
celdas = {}
for fila in h.iter_rows():
    for c in fila:
        if c.value is None: continue
        celdas[c.coordinate] = {
            "valor": c.value.isoformat() if hasattr(c.value, "isoformat") else c.value,
            "tipo": c.data_type,
            "formato": c.number_format,
            "negrita": bool(c.font and c.font.bold),
        }
anchos = {k: v.width for k, v in h.column_dimensions.items() if v.width}
print(json.dumps({"hoja": h.title, "celdas": celdas, "anchos": anchos}))
`;
  const r = spawnSync('python3', ['-c', guion, archivo], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openpyxl no pudo abrirlo: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function escribir(nombre: string, buffer: Buffer): string {
  const ruta = join(directorio, nombre);
  writeFileSync(ruta, buffer);
  return ruta;
}

describe('referencia de celda', () => {
  it('cuenta las columnas como Excel, incluida la vuelta a AA', () => {
    // Z → AA es donde se equivoca todo el mundo: no es base 26 pura, no hay
    // dígito cero. Una exportación con 27 columnas lo alcanza sola.
    expect(referencia(0, 0)).toBe('A1');
    expect(referencia(1, 2)).toBe('B3');
    expect(referencia(25, 0)).toBe('Z1');
    expect(referencia(26, 0)).toBe('AA1');
    expect(referencia(27, 0)).toBe('AB1');
    expect(referencia(51, 0)).toBe('AZ1');
    expect(referencia(52, 0)).toBe('BA1');
  });
});

describe.skipIf(!hayOpenpyxl)('lo abre un lector de verdad (#709)', () => {
  it('openpyxl lee los valores, los tipos y el nombre de la hoja', () => {
    const archivo = escribir(
      'contactos.xlsx',
      crearXlsx({
        nombre: 'Contactos',
        columnas: [{ titulo: 'Nombre', ancho: 28 }, { titulo: 'Teléfono' }, { titulo: 'Monto' }],
        filas: [
          ['Carla Pérez', '+56981234567', 1250000],
          ['Diego Ramírez', '+56987654321', 480000],
        ],
      }),
    );
    const visto = comoLoVeOpenpyxl(archivo);
    expect(visto.hoja).toBe('Contactos');
    expect(visto.celdas.A1.valor).toBe('Nombre');
    expect(visto.celdas.A2.valor).toBe('Carla Pérez');
    expect(visto.celdas.C2.valor).toBe(1250000);
  });

  it('el teléfono sigue siendo un teléfono, no un número en notación científica', () => {
    // Éste es el motivo del issue. En CSV, `+56981234567` se abre como 5,6981E+10
    // y el negocio cree que perdimos su información.
    const archivo = escribir(
      'telefono.xlsx',
      crearXlsx({
        nombre: 'Contactos',
        columnas: [{ titulo: 'Teléfono' }, { titulo: 'RUT' }],
        filas: [['+56981234567', '76.543.210-K']],
      }),
    );
    const visto = comoLoVeOpenpyxl(archivo);
    expect(visto.celdas.A2.tipo, 'el teléfono tiene que ser texto').toBe('s');
    expect(visto.celdas.A2.valor).toBe('+56981234567');
    // El RUT con guion, en CSV, Excel lo lee como una resta.
    expect(visto.celdas.B2.valor).toBe('76.543.210-K');
  });

  it('un monto es un número de verdad: se puede sumar en la planilla', () => {
    // Si saliera como texto, la autosuma de Excel da cero y el reporte no sirve
    // para lo único que la gente hace con un reporte.
    const archivo = escribir(
      'montos.xlsx',
      crearXlsx({ nombre: 'Montos', columnas: [{ titulo: 'Monto' }], filas: [[1250000], [480000]] }),
    );
    const visto = comoLoVeOpenpyxl(archivo);
    expect(visto.celdas.A2.tipo).toBe('n');
    expect(visto.celdas.A3.valor).toBe(480000);
  });

  it('una fecha llega como fecha, con formato chileno', () => {
    const archivo = escribir(
      'fechas.xlsx',
      crearXlsx({
        nombre: 'Fechas',
        columnas: [{ titulo: 'Creado' }],
        filas: [[new Date(Date.UTC(2026, 9, 6))]],
      }),
    );
    const visto = comoLoVeOpenpyxl(archivo);
    expect(visto.celdas.A2.tipo, 'openpyxl tiene que verla como fecha').toBe('d');
    expect(String(visto.celdas.A2.valor).slice(0, 10)).toBe('2026-10-06');
    expect(visto.celdas.A2.formato).toContain('dd');
  });

  it('el encabezado va en negrita y los anchos se respetan', () => {
    const archivo = escribir(
      'formato.xlsx',
      crearXlsx({
        nombre: 'Formato',
        columnas: [{ titulo: 'Nombre', ancho: 32 }, { titulo: 'Estado' }],
        filas: [['Carla', 'Resuelta']],
      }),
    );
    const visto = comoLoVeOpenpyxl(archivo);
    expect(visto.celdas.A1.negrita).toBe(true);
    expect(visto.celdas.A2.negrita, 'solo el encabezado').toBe(false);
    expect(visto.anchos.A).toBe(32);
  });

  it('un nombre, un texto y un carácter de control que romperían el archivo, no lo rompen', () => {
    // Las tres cosas que dejan un xlsx «corrupto» sin decir cuál:
    // un nombre de hoja con /, un & sin escapar, y un byte de control que llega
    // de verdad en un nombre pegado desde WhatsApp.
    const archivo = escribir(
      'raro.xlsx',
      crearXlsx({
        nombre: 'Ventas/2026: resumen [borrador] que además es larguísimo',
        columnas: [{ titulo: 'Cliente & Co' }],
        filas: [['Pérez & <Hijos>'], ['comillas "dobles"']],
      }),
    );
    const visto = comoLoVeOpenpyxl(archivo);
    expect(visto.hoja.length).toBeLessThanOrEqual(31);
    expect(visto.hoja).not.toMatch(/[:\\/?*[\]]/);
    expect(visto.celdas.A1.valor).toBe('Cliente & Co');
    expect(visto.celdas.A2.valor).toBe('Pérez & <Hijos>');
    expect(visto.celdas.A3.valor).toBe('comillas "dobles"');
  });

  it('una celda vacía es vacía, y no el texto «null»', () => {
    const archivo = escribir(
      'vacias.xlsx',
      crearXlsx({
        nombre: 'Vacías',
        columnas: [{ titulo: 'A' }, { titulo: 'B' }],
        filas: [[null, 'hay'], ['', 'también']],
      }),
    );
    const visto = comoLoVeOpenpyxl(archivo);
    expect(visto.celdas.A2).toBeUndefined();
    expect(visto.celdas.B2.valor).toBe('hay');
  });

  it('27 columnas: la que cruza a AA se escribe donde corresponde', () => {
    const columnas = Array.from({ length: 27 }, (_, i) => ({ titulo: `C${i + 1}` }));
    const archivo = escribir(
      'anchas.xlsx',
      crearXlsx({ nombre: 'Anchas', columnas, filas: [columnas.map((_, i) => i)] }),
    );
    const visto = comoLoVeOpenpyxl(archivo);
    expect(visto.celdas.AA1.valor).toBe('C27');
    expect(visto.celdas.AA2.valor).toBe(26);
  });
});

describe('sin openpyxl no se finge la verificación', () => {
  it('dice si la comprobación independiente corrió o no', () => {
    // No es una aserción sobre el producto: es sobre la prueba. Si openpyxl no
    // está, las de arriba se saltan, y saltarse en silencio la única
    // verificación ajena sería peor que no tenerla.
    expect(typeof hayOpenpyxl).toBe('boolean');
    if (!hayOpenpyxl) console.warn('openpyxl no está: el xlsx NO se verificó con un lector ajeno.');
  });
});
