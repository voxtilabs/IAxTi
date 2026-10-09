import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Las columnas que guardan QUIÉN, y quién las lee (#697).
 *
 * Medido el 08/10: nueve columnas `*_by` / `*_por` se escribían en cada acción
 * y **ninguna pantalla las mostraba**. Quién apagó la IA, quién lanzó la
 * campaña a 650 personas, quién aprobó lo que propuso el agente, a quién se le
 * quitó la conversación. No es vanidad de auditoría: son las preguntas que se
 * hacen cuando algo sale mal.
 *
 * El patrón —escrito en un lado, leído en ninguno— se repite solo, porque la
 * columna no avisa: el `INSERT` compila, la migración pasa, y la ausencia del
 * lector no rompe nada. Ya pasó con `won_at` (#695), con `company_id` (#460) y
 * con el consentimiento (#696). Esta guarda es para que la próxima avise.
 *
 * Mide UNA cosa comprobable: que algo LEA la columna. Vale cualquiera de tres:
 * aparece en una consulta de lectura, su nombre en camelCase aparece en el
 * código, o el código accede a ella como propiedad de una fila
 * (`row.applied_by` después de un `SELECT *`).
 *
 * `INSERT`, `UPDATE` y `DELETE` NO cuentan —son la escritura, que es justo lo
 * que sí existía— y un `RETURNING *` tampoco: que la fila vuelva no significa
 * que alguien la mire, y ése fue exactamente el caso de `won_at` (#695).
 */

const IGNORADOS = new Set(['node_modules', 'dist', '.next', '.claude', '.git', 'coverage']);

/** `_by` y `_por` al final: el sufijo con el que este repo nombra al autor. */
const ES_DE_AUTOR = /_(by|por)$/;

function archivos(dir: string, extension: RegExp, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (IGNORADOS.has(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) archivos(ruta, extension, acc);
    else if (extension.test(entrada)) acc.push(ruta);
  }
  return acc;
}

/** `created_by` → `createdBy`, que es como la lee el código. */
export function enCamello(columna: string): string {
  return columna.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export interface ColumnaDeAutor {
  tabla: string;
  columna: string;
}

/**
 * Las columnas de autor declaradas en las migraciones.
 *
 * Se leen de `CREATE TABLE` y de `ALTER TABLE ... ADD COLUMN`, que son las dos
 * formas en que este repo agrega una columna (las migraciones son aditivas).
 */
export function columnasDeAutor(raices: string[]): ColumnaDeAutor[] {
  const encontradas = new Map<string, ColumnaDeAutor>();
  for (const sql of raices.flatMap((r) => archivos(r, /\.sql$/))) {
    const texto = readFileSync(sql, 'utf8').replace(/--[^\n]*/g, '');

    for (const m of texto.matchAll(
      /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi,
    )) {
      const tabla = m[1];
      for (const linea of m[2].split('\n')) {
        const col = /^\s*([a-z_][a-z0-9_]*)\s+[a-z]/i.exec(linea)?.[1];
        if (col && ES_DE_AUTOR.test(col)) encontradas.set(`${tabla}.${col}`, { tabla, columna: col });
      }
    }
    for (const m of texto.matchAll(
      /ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi,
    )) {
      if (ES_DE_AUTOR.test(m[2])) encontradas.set(`${m[1]}.${m[2]}`, { tabla: m[1], columna: m[2] });
    }
  }
  return [...encontradas.values()].sort((a, b) =>
    `${a.tabla}.${a.columna}`.localeCompare(`${b.tabla}.${b.columna}`),
  );
}

/**
 * Las consultas de LECTURA de un archivo.
 *
 * Las consultas de este repo viven en plantillas con acentos graves o en
 * cadenas simples. Una que empieza con `INSERT`, `UPDATE` o `DELETE` es
 * escritura y se descarta entera: con su `RETURNING *` incluido, porque devolver
 * la fila no es lo mismo que mostrarla.
 */
function consultasDeLectura(codigo: string): string[] {
  const lecturas: string[] = [];
  for (const m of codigo.matchAll(/`([^`]*)`|'([^'\n]*)'/g)) {
    const texto = m[1] ?? m[2] ?? '';
    if (!/\bSELECT\b/i.test(texto)) continue;
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(texto.trim())) continue;
    lecturas.push(texto);
  }
  return lecturas;
}

/** El código sin comentarios: acá se explica por qué algo NO se usa. */
function sinComentarios(codigo: string): string {
  return codigo
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

/**
 * Las que nadie lee, como `tabla.columna`.
 *
 * Los `tests/` quedan fuera a propósito: una prueba que afirma que la columna se
 * escribió no la convierte en algo que el producto muestre, y dejarlas dentro
 * haría que la guarda se pusiera verde escribiendo una prueba.
 */
/**
 * Qué columnas de autor lee cada archivo, como `tabla.columna`.
 *
 * Separada y pura para poder probarla: la guarda se cae sola si el escáner deja
 * de distinguir una escritura de una lectura, y eso no se nota con el repo
 * verde. Se le pasan textos y no rutas por lo mismo.
 *
 * **La tabla importa.** Hay tres `created_by` en tablas distintas, y una guarda
 * que solo mirara el nombre de la columna se pondría verde para las tres en
 * cuanto una sola tuviera lector — que es precisamente el error que esta guarda
 * viene a cazar. Así que el archivo tiene que nombrar la tabla ADEMÁS de leer la
 * columna: en este repo la consulta y su mapeador viven juntos, así que esa
 * cercanía es señal y no casualidad.
 */
export function lecturasPorTabla(
  columnas: ReadonlyArray<ColumnaDeAutor>,
  textos: string[],
): Set<string> {
  const leidas = new Set<string>();
  for (const bruto of textos) {
    const texto = sinComentarios(bruto);
    const enEsteArchivo = new Set<string>();

    // 1. Proyectada en una consulta de lectura.
    for (const consulta of consultasDeLectura(texto)) {
      for (const m of consulta.matchAll(/\b([a-z_][a-z0-9_]*_(?:by|por))\b/g)) {
        enEsteArchivo.add(m[1]);
      }
    }
    // 2. Tomada de la fila de un `SELECT *`: `row.applied_by`.
    for (const m of texto.matchAll(/\.([a-z_][a-z0-9_]*_(?:by|por))\b/g)) enEsteArchivo.add(m[1]);
    // 3. Nombrada en camelCase, que es como la lleva un DTO: `createdBy`.
    for (const m of texto.matchAll(/\b([a-zA-Z]+(?:By|Por))\b/g)) {
      enEsteArchivo.add(m[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
    }
    if (enEsteArchivo.size === 0) continue;

    for (const c of columnas) {
      if (!enEsteArchivo.has(c.columna)) continue;
      if (!new RegExp(`\\b${c.tabla}\\b`).test(texto)) continue;
      leidas.add(`${c.tabla}.${c.columna}`);
    }
  }
  return leidas;
}

/**
 * Las que nadie lee, como `tabla.columna`.
 *
 * Los `tests/` quedan fuera a propósito: una prueba que afirma que la columna se
 * escribió no la convierte en algo que el producto muestre, y dejarlas dentro
 * haría que la guarda se pusiera verde escribiendo una prueba. Las migraciones
 * también: son la escritura.
 */
export function columnasDeAutorSinLector(raices: string[], fuentes: string[]): string[] {
  const columnas = columnasDeAutor(raices);
  const textos = fuentes
    .flatMap((r) => archivos(r, /\.tsx?$/))
    .filter((f) => !/[/\\]tests?[/\\]/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => readFileSync(f, 'utf8'));
  const leidas = lecturasPorTabla(columnas, textos);
  return columnas
    .map((c) => `${c.tabla}.${c.columna}`)
    .filter((nombre) => !leidas.has(nombre));
}
