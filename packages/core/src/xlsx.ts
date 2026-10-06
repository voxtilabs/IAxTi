import { crearZip } from './zip';

/**
 * Un escritor de XLSX mínimo, sin dependencias (#709).
 *
 * Mismo criterio que el ZIP de al lado y que la firma SigV4 de R2: un formato
 * conocido, escrito acá, con sus pruebas, en vez de una dependencia que pasa por
 * la política de cadena de suministro y hay que mantener. Y encaja solo, porque
 * **un xlsx ES un zip con XML**: esto se apoya en `crearZip`.
 *
 * Por qué no basta el CSV, que ya existe:
 *
 *   · Excel en español espera punto y coma, no coma. El BOM arregla los acentos
 *     y no el separador, así que la mitad de las veces llega todo en una columna.
 *   · El CSV no tiene tipos. `+56981234567` se abre como número en notación
 *     científica y el negocio cree que perdimos su información; un RUT con guion
 *     se vuelve una resta.
 *   · No se le puede dar formato, y un reporte que se le muestra a un cliente no
 *     puede verse como texto separado por comas.
 *
 * Lo que soporta: texto, número, fecha y booleano; encabezado en negrita; ancho
 * de columna. Nada más. Sin fórmulas, sin varias hojas, sin estilos por celda,
 * sin imágenes. Si algún día hace falta un gráfico dentro de la planilla, eso es
 * otra conversación y probablemente otra herramienta.
 *
 * Las cadenas van EN LÍNEA (`t="inlineStr"`) y no en una tabla compartida. La
 * tabla ahorra bytes cuando hay mucha repetición; acá lo que importa es que el
 * archivo sea obvio de leer y de depurar, y una exportación de contactos no se
 * repite tanto como para notarlo.
 */

/** Lo que puede ir en una celda. `null` deja la celda vacía, que no es lo mismo que "". */
export type ValorCelda = string | number | boolean | Date | null;

export interface ColumnaXlsx {
  /** El encabezado, tal como se lee. */
  titulo: string;
  /** Ancho en caracteres. Sin esto Excel usa 8,43 y corta los nombres. */
  ancho?: number;
}

export interface HojaXlsx {
  /** Nombre de la pestaña. Excel no acepta : \ / ? * [ ] ni más de 31 caracteres. */
  nombre: string;
  columnas: ColumnaXlsx[];
  filas: ValorCelda[][];
}

/** Excel cuenta los días desde el 1899-12-30, por un bug de Lotus que decidió conservar. */
const EPOCA_EXCEL = Date.UTC(1899, 11, 30);

function serialDeFecha(d: Date): number {
  return (d.getTime() - EPOCA_EXCEL) / 86_400_000;
}

/**
 * El nombre de la hoja, saneado.
 *
 * Excel no abre el archivo si el nombre trae un carácter prohibido —y no avisa
 * cuál: dice que está corrupto— así que esto se resuelve acá y no en quien llama.
 */
function nombreDeHoja(nombre: string): string {
  const limpio = nombre.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31);
  return limpio === '' ? 'Hoja1' : limpio;
}

/**
 * Saca los caracteres de control, que no son XML válido.
 *
 * Llegan de verdad: un nombre pegado desde WhatsApp puede traer un byte
 * invisible, y con eso el archivo ENTERO deja de abrir — Excel no dice «hay un
 * carácter raro en la fila 3», dice que está dañado.
 *
 * Escrito a mano y no con un regex porque un regex con caracteres de control
 * adentro es ilegible y eslint lo rechaza, con razón: lo que uno ve en el
 * código no es lo que el motor compila. Acá los códigos están a la vista.
 *
 * XML 1.0 admite tabulador, salto de línea y retorno de carro; nada más bajo
 * 0x20. Los tres se conservan: un texto de varias líneas en una celda es
 * legítimo.
 */
function sinControles(texto: string): string {
  let salida = '';
  for (const caracter of texto) {
    const codigo = caracter.codePointAt(0) ?? 0;
    if (codigo < 0x20 && codigo !== 0x09 && codigo !== 0x0a && codigo !== 0x0d) continue;
    salida += caracter;
  }
  return salida;
}

function escapar(texto: string): string {
  return sinControles(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** La referencia de una celda: columna 0 y fila 0 son "A1". */
export function referencia(columna: number, fila: number): string {
  let letras = '';
  let n = columna;
  do {
    letras = String.fromCharCode(65 + (n % 26)) + letras;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `${letras}${fila + 1}`;
}

function celda(valor: ValorCelda, ref: string, estilo: number): string {
  if (valor === null || valor === undefined) return '';
  const s = estilo > 0 ? ` s="${estilo}"` : '';
  if (typeof valor === 'number') {
    // NaN e Infinity no existen en el formato: una celda vacía dice la verdad,
    // y escribirlos deja el archivo sin abrir.
    if (!Number.isFinite(valor)) return '';
    return `<c r="${ref}"${s}><v>${valor}</v></c>`;
  }
  if (typeof valor === 'boolean') return `<c r="${ref}"${s} t="b"><v>${valor ? 1 : 0}</v></c>`;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return '';
    return `<c r="${ref}" s="2"><v>${serialDeFecha(valor)}</v></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapar(valor)}</t></is></c>`;
}

function hojaXml(hoja: HojaXlsx): string {
  const cols = hoja.columnas
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.ancho ?? 18}" customWidth="1"/>`)
    .join('');
  const encabezado = hoja.columnas.map((c, i) => celda(c.titulo, referencia(i, 0), 1)).join('');
  const filas = hoja.filas
    .map((fila, f) => {
      const celdas = fila.map((v, i) => celda(v, referencia(i, f + 1), 0)).join('');
      return `<row r="${f + 2}">${celdas}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>${cols}</cols>
<sheetData><row r="1">${encabezado}</row>${filas}</sheetData>
</worksheet>`;
}

/**
 * Los estilos, los tres que hacen falta:
 *   0  normal
 *   1  encabezado en negrita
 *   2  fecha, con el formato chileno dd-mm-aaaa
 */
const ESTILOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\-mm\\-yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** Una planilla con una hoja. Devuelve el `.xlsx` listo para mandar. */
export function crearXlsx(hoja: HojaXlsx, cuando = new Date()): Buffer {
  const nombre = nombreDeHoja(hoja.nombre);
  return crearZip(
    [
      {
        nombre: '[Content_Types].xml',
        contenido: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
      },
      {
        nombre: '_rels/.rels',
        contenido: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
      },
      {
        nombre: 'xl/workbook.xml',
        contenido: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapar(nombre)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
      },
      {
        nombre: 'xl/_rels/workbook.xml.rels',
        contenido: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
      },
      { nombre: 'xl/styles.xml', contenido: ESTILOS },
      { nombre: 'xl/worksheets/sheet1.xml', contenido: hojaXml(hoja) },
    ],
    cuando,
  );
}
