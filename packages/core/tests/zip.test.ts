import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { crc32, crearZip } from '../src/zip';

/**
 * El escritor de zip (issue 222). Se comprueba LEYENDO lo escrito con un
 * lector aparte —el directorio central, que es por donde entra cualquier
 * herramienta de verdad—, no confiando en las mismas cuentas que lo
 * escribieron.
 *
 * Verificado además contra `unzip -t` y contra el módulo `zipfile` de
 * Python: los dos lo abren sin quejarse.
 */

/** Lector mínimo: entra por el final, como manda el formato. */
function leerZip(buf: Buffer): Array<{ nombre: string; contenido: Buffer; metodo: number }> {
  const fin = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(fin, 'no se encontró el fin del directorio central').toBeGreaterThan(-1);
  const total = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);
  const salida = [];
  for (let i = 0; i < total; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const metodo = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const comprimido = buf.readUInt32LE(p + 20);
    const crudo = buf.readUInt32LE(p + 24);
    const largoNombre = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const nombre = buf.subarray(p + 46, p + 46 + largoNombre).toString('utf8');

    // Y ahora por el encabezado local, que es donde están los datos.
    expect(buf.readUInt32LE(offset)).toBe(0x04034b50);
    const nombreLocal = buf.readUInt16LE(offset + 26);
    const extraLocal = buf.readUInt16LE(offset + 28);
    const inicio = offset + 30 + nombreLocal + extraLocal;
    const datos = buf.subarray(inicio, inicio + comprimido);
    const contenido = metodo === 8 ? inflateRawSync(datos) : Buffer.from(datos);

    expect(contenido.length, `${nombre}: tamaño declarado`).toBe(crudo);
    expect(crc32(contenido), `${nombre}: CRC declarado`).toBe(crc);
    salida.push({ nombre, contenido, metodo });
    p += 46 + largoNombre + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return salida;
}

describe('crc32', () => {
  it('coincide con los valores conocidos del algoritmo', () => {
    expect(crc32(Buffer.from(''))).toBe(0);
    // El "check value" del CRC-32 de toda la vida.
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.from('IAxTi'))).toBe(crc32(Buffer.from('IAxTi')));
  });
});

describe('crearZip', () => {
  const cuando = new Date('2026-09-15T12:34:56Z');

  it('lo escrito se puede volver a leer, con acentos y carpetas', () => {
    const zip = crearZip(
      [
        { nombre: 'contactos.csv', contenido: 'id,nombre\n1,Paula Soto\n' },
        { nombre: 'datos/conversaciones.json', contenido: '[{"id":"c1"}]' },
        { nombre: 'ñandú/mañana.txt', contenido: 'acentuación y eñes' },
      ],
      cuando,
    );
    const leidos = leerZip(zip);
    expect(leidos.map((a) => a.nombre)).toEqual([
      'contactos.csv',
      'datos/conversaciones.json',
      'ñandú/mañana.txt',
    ]);
    expect(leidos[0].contenido.toString()).toBe('id,nombre\n1,Paula Soto\n');
    expect(leidos[2].contenido.toString()).toBe('acentuación y eñes');
  });

  it('comprime por omisión y respeta cuando se le pide que no', () => {
    const repetido = 'a'.repeat(5_000);
    const zip = crearZip([
      { nombre: 'comprimido.txt', contenido: repetido },
      { nombre: 'tal-cual.txt', contenido: repetido, comprimir: false },
    ], cuando);
    const [comprimido, talCual] = leerZip(zip);
    expect(comprimido.metodo).toBe(8);
    expect(talCual.metodo).toBe(0);
    expect(comprimido.contenido.toString()).toBe(repetido);
    expect(talCual.contenido.toString()).toBe(repetido);
    // Y comprimir sirve de algo: 5 kB de la misma letra no ocupan 5 kB.
    expect(zip.length).toBeLessThan(repetido.length * 2);
  });

  it('un binario cualquiera sobrevive byte a byte', () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const [leido] = leerZip(crearZip([{ nombre: 'bytes.bin', contenido: bytes }], cuando));
    expect(Buffer.compare(leido.contenido, bytes)).toBe(0);
  });

  it('un zip vacío sigue siendo un zip', () => {
    const zip = crearZip([], cuando);
    expect(leerZip(zip)).toEqual([]);
    expect(zip.length).toBe(22); // solo el fin del directorio
  });
});
