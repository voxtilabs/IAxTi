import { afterEach, describe, expect, it, vi } from 'vitest';
import { armarPaquete, VIGENCIA_DE_ENLACES_SEG } from '../src/paquete-de-exportacion';
import type { ExportacionTenant } from '@iaxti/module-organizations';

/**
 * El paquete que se lleva el negocio (#583).
 *
 * Lo que esto cuida, en orden: que los archivos lleguen con una forma de
 * bajarlos, que lo que NO entró se diga, y que el zip se pueda abrir.
 */
const AHORA = new Date('2026-10-10T12:00:00.000Z');

function exportacionDePrueba(extra: Partial<ExportacionTenant> = {}): ExportacionTenant {
  return {
    tenant: { id: 't1', name: 'Peluquería Marisol' },
    generadoEl: AHORA.toISOString(),
    datos: { contacts: [{ id: 'c1', name: 'Ana' }] },
    resumen: { contacts: 1 },
    truncadas: [],
    fuera: { api_keys: 'De la credencial solo guardamos el hash, y un hash no se exporta.' },
    adjuntos: [
      {
        key: 't1/conv-1/1700000000-cotizacion.pdf',
        nombre: 'cotizacion.pdf',
        conversationId: 'conv-1',
        messageId: 'm1',
        bytes: 12345,
        contentType: 'application/pdf',
      },
    ],
    adjuntosFuera: 0,
    ...extra,
  } as ExportacionTenant;
}

afterEach(() => vi.unstubAllEnvs());

function conAlmacen() {
  vi.stubEnv('R2_ENDPOINT', 'https://cuenta.r2.cloudflarestorage.com');
  // `R2_BUCKET_ADJUNTOS`, que es el nombre que lee `storageFromEnv`. Puse
  // `R2_BUCKET` de memoria y el almacén salió null: la prueba decía «cero
  // enlaces» y tenía razón — sobre MI variable, no sobre el código.
  vi.stubEnv('R2_BUCKET_ADJUNTOS', 'iaxti');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'llave-de-prueba');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'secreto-de-prueba');
}

/** Lee los nombres y el contenido del zip sin dependencias: su propio formato. */
function leerZip(zip: Buffer): Map<string, string> {
  const archivos = new Map<string, string>();
  let i = 0;
  while (i < zip.length - 4 && zip.readUInt32LE(i) === 0x04034b50) {
    const metodo = zip.readUInt16LE(i + 8);
    const comprimido = zip.readUInt32LE(i + 18);
    const largoNombre = zip.readUInt16LE(i + 26);
    const largoExtra = zip.readUInt16LE(i + 28);
    const nombre = zip.subarray(i + 30, i + 30 + largoNombre).toString('utf8');
    const inicio = i + 30 + largoNombre + largoExtra;
    const datos = zip.subarray(inicio, inicio + comprimido);
    // `crearZip` usa deflate crudo (método 8) o guardado (0).
    archivos.set(
      nombre,
      metodo === 8
        ? // eslint-disable-next-line @typescript-eslint/no-require-imports
          (require('node:zlib') as typeof import('node:zlib')).inflateRawSync(datos).toString('utf8')
        : datos.toString('utf8'),
    );
    i = inicio + comprimido;
  }
  return archivos;
}

describe('el paquete de exportación', () => {
  it('trae los tres archivos y el zip se puede leer', () => {
    conAlmacen();
    const { zip, nombre } = armarPaquete(exportacionDePrueba(), { ahora: AHORA });
    expect(nombre).toBe('iaxti-2026-10-10.zip');
    const dentro = leerZip(zip);
    expect([...dentro.keys()].sort()).toEqual(['ADJUNTOS.csv', 'LEEME.txt', 'datos.json']);
  });

  it('cada adjunto sale con un enlace firmado que se puede usar', () => {
    conAlmacen();
    const { zip, conEnlace } = armarPaquete(exportacionDePrueba(), { ahora: AHORA });
    expect(conEnlace).toBe(1);
    const csv = leerZip(zip).get('ADJUNTOS.csv')!;

    // El nombre con el que se subió, no la llave de máquina: sin eso el negocio
    // recibe archivos con prefijos y no reconoce ninguno.
    expect(csv).toContain('cotizacion.pdf');
    // Y un enlace de verdad, firmado, con la vigencia pedida.
    expect(csv).toMatch(/https:\/\/cuenta\.r2\.cloudflarestorage\.com/);
    expect(csv).toContain('X-Amz-Signature=');
    expect(csv).toContain(`X-Amz-Expires=${VIGENCIA_DE_ENLACES_SEG}`);
  });

  it('el JSON lleva los MISMOS adjuntos con su enlace, no las llaves peladas', () => {
    conAlmacen();
    const { zip } = armarPaquete(exportacionDePrueba(), { ahora: AHORA });
    const datos = JSON.parse(leerZip(zip).get('datos.json')!);
    // Era `string[]` con las llaves de R2 y nada más: la referencia a las fotos
    // en vez de las fotos (#583).
    expect(typeof datos.adjuntos[0]).toBe('object');
    expect(datos.adjuntos[0].nombre).toBe('cotizacion.pdf');
    expect(datos.adjuntos[0].url).toContain('X-Amz-Signature=');
  });

  it('el LEEME dice hasta cuándo sirven los enlaces, con la fecha', () => {
    conAlmacen();
    const { zip } = armarPaquete(exportacionDePrueba(), { ahora: AHORA });
    const leeme = leerZip(zip).get('LEEME.txt')!;
    expect(leeme).toContain('LOS ENLACES VENCEN');
    // Siete días desde el 10/10.
    expect(leeme).toContain('2026-10-17');
    expect(leeme).toContain('vuelve a pedir la');
  });

  /**
   * Y esa fecha en la zona del NEGOCIO (#1076).
   *
   * El vencimiento es un instante —siete días, el máximo que SigV4 permite
   * firmar—, así que `toISOString()` prometía un día que en Chile ya había
   * pasado: con el vencimiento a las 02:00 UTC, los enlaces mueren a las
   * 23:00 del día ANTERIOR al que decía el archivo. De los seis sitios de
   * esta familia este es el único donde la persona ACTÚA sobre la fecha:
   * se guía por el README y se queda sin sus adjuntos.
   */
  it('y la fecha es del día del negocio, no de UTC', () => {
    conAlmacen();
    // 23:30 del 10 en Chile son las 02:30 UTC del 11; siete días después,
    // las 02:30 UTC del 18 — que en Chile es todavía el 17 a las 23:30.
    const casiMedianoche = new Date('2026-10-11T02:30:00.000Z');
    const leeme = (zona?: string) =>
      leerZip(armarPaquete(exportacionDePrueba(), { ahora: casiMedianoche, zona }).zip).get('LEEME.txt')!;

    expect(leeme('America/Santiago')).toContain('funcionan hasta el 2026-10-17');
    // El 18 es lo que decía UTC, y para el negocio no llega: si aparece, la
    // fecha volvió a salir del reloj equivocado.
    expect(leeme('America/Santiago')).not.toContain('2026-10-18');
    // Sin zona se usa la del producto, que es la misma de Chile.
    expect(leeme()).toContain('funcionan hasta el 2026-10-17');
    // Y un negocio al otro lado ve SU día: en Auckland ese instante ya es el 18.
    expect(leeme('Pacific/Auckland')).toContain('funcionan hasta el 2026-10-18');
  });

  it('lo que NO entró se dice, en el paquete', () => {
    conAlmacen();
    const { zip } = armarPaquete(
      exportacionDePrueba({ adjuntosFuera: 120, truncadas: ['messages'] }),
      { ahora: AHORA },
    );
    const leeme = leerZip(zip).get('LEEME.txt')!;
    // Una exportación que calla lo que no incluyó es peor que una que avisa,
    // porque se descubre cuando el negocio ya canceló.
    expect(leeme).toContain('120 archivos NO entraron');
    expect(leeme).toContain('LO QUE NO SALIÓ COMPLETO');
    expect(leeme).toContain('messages');
  });

  it('sin almacén configurado NO se inventa un enlace, y el LEEME lo dice', () => {
    // Mentir con un enlace roto es peor que decir que falta: el negocio lo
    // descubre cuando intenta bajar sus cosas, y ya canceló.
    const { zip, conEnlace } = armarPaquete(exportacionDePrueba(), { ahora: AHORA });
    expect(conEnlace).toBe(0);
    const dentro = leerZip(zip);
    expect(dentro.get('ADJUNTOS.csv')).toContain('cotizacion.pdf');
    expect(dentro.get('LEEME.txt')).toContain('sin enlaces');
    expect(dentro.get('ADJUNTOS.csv')).not.toContain('X-Amz-Signature');
  });

  it('el CSV no deja pasar una fórmula: un nombre de archivo es un dato', () => {
    conAlmacen();
    const { zip } = armarPaquete(
      exportacionDePrueba({
        adjuntos: [
          {
            key: 't1/c/=cmd.pdf',
            nombre: '=HYPERLINK("http://malo","click")',
            conversationId: 'c',
            messageId: 'm',
            bytes: 1,
            contentType: 'application/pdf',
          },
        ],
      }),
      { ahora: AHORA },
    );
    const csv = leerZip(zip).get('ADJUNTOS.csv')!;
    // Con el apóstrofo adelante, Excel lo abre como texto y no como fórmula. El
    // nombre lo eligió quien subió el archivo: es entrada, no contenido nuestro.
    expect(csv).toContain('"\'=HYPERLINK');
  });
});
