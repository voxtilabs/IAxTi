import { deflateRawSync } from 'node:zlib';

/**
 * Un escritor de ZIP mínimo, sin dependencias (SPEC §19, issue 222).
 *
 * La exportación completa de un tenant tiene que llegarle al dueño de una
 * peluquería como un archivo que pueda abrir con doble clic. Eso es un zip,
 * y para hacerlo había dos caminos: sumar una dependencia al lockfile —que
 * pasa por la política de cadena de suministro y hay que mantener— o
 * escribir el formato, que es viejo, estable y cabe en una página.
 *
 * Mismo criterio que la firma SigV4 de R2: formato conocido, escrito acá,
 * con sus pruebas.
 *
 * Lo que soporta: archivos (deflate o guardados tal cual), nombres UTF-8,
 * y nada más. Sin carpetas vacías, sin zip64, sin cifrado. Si algún día un
 * export pasa de 4 GB o de 65.535 archivos hará falta zip64 — hoy eso sería
 * un problema bueno de tener.
 */

const TABLA_CRC = (() => {
  const tabla = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[i] = c;
  }
  return tabla;
})();

export function crc32(datos: Buffer): number {
  let c = 0xffffffff;
  for (const byte of datos) c = TABLA_CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ArchivoZip {
  /** Ruta dentro del zip; las barras hacen las carpetas. */
  nombre: string;
  contenido: Buffer | string;
  /** Por omisión se comprime. Sirve apagarlo para lo que ya viene comprimido. */
  comprimir?: boolean;
}

/** Fecha y hora en el formato de MS-DOS que usa el zip (segundos pares). */
function fechaDos(d: Date): { hora: number; fecha: number } {
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const fecha = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { hora, fecha };
}

export function crearZip(archivos: ArchivoZip[], cuando = new Date()): Buffer {
  const { hora, fecha } = fechaDos(cuando);
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let offset = 0;

  for (const archivo of archivos) {
    const nombre = Buffer.from(archivo.nombre, 'utf8');
    const crudo = Buffer.isBuffer(archivo.contenido)
      ? archivo.contenido
      : Buffer.from(archivo.contenido, 'utf8');
    const comprimir = archivo.comprimir ?? true;
    const datos = comprimir ? deflateRawSync(crudo) : crudo;
    const metodo = comprimir ? 8 : 0;
    const crc = crc32(crudo);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versión necesaria
    local.writeUInt16LE(0x0800, 6); // bandera: nombres en UTF-8
    local.writeUInt16LE(metodo, 8);
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(fecha, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(datos.length, 18);
    local.writeUInt32LE(crudo.length, 22);
    local.writeUInt16LE(nombre.length, 26);
    local.writeUInt16LE(0, 28); // sin campo extra
    locales.push(local, nombre, datos);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // versión de quien lo creó
    central.writeUInt16LE(20, 6); // versión necesaria
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(metodo, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(fecha, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(datos.length, 20);
    central.writeUInt32LE(crudo.length, 24);
    central.writeUInt16LE(nombre.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comentario
    central.writeUInt16LE(0, 34); // disco
    central.writeUInt16LE(0, 36); // atributos internos
    central.writeUInt32LE(0, 38); // atributos externos
    central.writeUInt32LE(offset, 42);
    centrales.push(central, nombre);

    offset += local.length + nombre.length + datos.length;
  }

  const cuerpo = Buffer.concat(locales);
  const directorio = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(0, 4); // número de disco
  fin.writeUInt16LE(0, 6); // disco donde empieza el directorio
  fin.writeUInt16LE(archivos.length, 8);
  fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(cuerpo.length, 16);
  fin.writeUInt16LE(0, 20); // sin comentario

  return Buffer.concat([cuerpo, directorio, fin]);
}
