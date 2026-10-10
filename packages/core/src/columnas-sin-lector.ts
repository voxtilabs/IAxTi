import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from './testing/fuente-limpia';

/**
 * Columnas que se escriben y nadie lee (#703).
 *
 * Medido el 08/10 cruzando las migraciones contra todo el código: **28 columnas
 * se escribían y ningún `SELECT` las devolvía**. De ahí salieron ocho issues
 * —#695 a #702— y éste es el trinquete para que la número 29 avise sola.
 *
 * El patrón es el mismo de toda esa semana: **declarado en un lado, aplicado en
 * ninguno**. Una columna sin lector no rompe nada, no sale en ninguna prueba y
 * no aparece en ningún log. Simplemente la función no existe, y el esquema da la
 * impresión contraria: a quien lo lee le parece que eso ya está hecho.
 *
 * Y se acumula sola. `agent_executions.tools_called` estuvo guardando `[]` en
 * cada corrida desde `0001_agents.sql`.
 *
 * Esta familia de guardas ya existe y funciona: rutas sin consumidor (#447),
 * exports de contrato sin llamador (#664), el `.sha` leído a mano (#675).
 * Faltaba la de columnas.
 */

const IGNORADOS = new Set(['node_modules', 'dist', '.next', '.claude', '.git', 'coverage']);

export interface Columna {
  tabla: string;
  columna: string;
}

function archivos(dir: string, extension: RegExp, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (IGNORADOS.has(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) archivos(ruta, extension, acc);
    else if (extension.test(entrada)) acc.push(ruta);
  }
  return acc;
}

/**
 * `_by` y `_por` al final: el sufijo con el que este repo nombra al autor.
 *
 * La guarda de #697 mira solo esta familia; la de #703 las mira todas. Es el
 * mismo escáner con un filtro, a propósito: dos implementaciones del mismo
 * cruce se desincronizan, y ya pasó con el `.sha` del despliegue (#675).
 */
export const ES_DE_AUTOR = (columna: string): boolean => /_(by|por)$/.test(columna);

/** `created_by` → `createdBy`, que es como la lee un DTO. */
export function enCamello(columna: string): string {
  return columna.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** `createdBy` → `created_by`, para comparar contra la migración. */
function aSnake(identificador: string): string {
  return identificador.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Las columnas declaradas en las migraciones.
 *
 * Se leen de `CREATE TABLE` y de `ALTER TABLE ... ADD COLUMN`, que son las dos
 * formas en que este repo agrega una columna (las migraciones son aditivas).
 *
 * `filtro` permite mirar una familia: la guarda de autores (#697) pide solo las
 * `*_by` / `*_por`.
 */
export function columnasDeclaradas(
  raices: string[],
  filtro: (columna: string) => boolean = () => true,
): Columna[] {
  const encontradas = new Map<string, Columna>();
  for (const sql of raices.flatMap((r) => archivos(r, /\.sql$/))) {
    const texto = readFileSync(sql, 'utf8').replace(/--[^\n]*/g, '');

    for (const m of texto.matchAll(
      /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi,
    )) {
      const tabla = m[1];
      for (const linea of m[2].split('\n')) {
        const col = /^\s*([a-z_][a-z0-9_]*)\s+[a-z]/i.exec(linea)?.[1];
        // `primary`, `unique`, `constraint`, `check`, `foreign` abren una
        // restricción de tabla, no una columna.
        if (!col || /^(primary|unique|constraint|check|foreign|exclude|like)$/i.test(col)) continue;
        if (filtro(col)) encontradas.set(`${tabla}.${col}`, { tabla, columna: col });
      }
    }
    for (const m of texto.matchAll(
      /ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi,
    )) {
      if (filtro(m[2])) encontradas.set(`${m[1]}.${m[2]}`, { tabla: m[1], columna: m[2] });
    }
  }
  return [...encontradas.values()].sort((a, b) =>
    `${a.tabla}.${a.columna}`.localeCompare(`${b.tabla}.${b.columna}`),
  );
}

/** El código sin comentarios: acá se explica por qué algo NO se usa. */
/** Las cadenas con SQL de un archivo: plantillas o cadenas simples. */
function consultas(codigo: string): string[] {
  const todas: string[] = [];
  for (const m of codigo.matchAll(/`([^`]*)`|'([^'\n]*)'/g)) {
    const texto = m[1] ?? m[2] ?? '';
    if (/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(texto)) todas.push(texto);
  }
  return todas;
}

/**
 * Qué parte de una consulta cuenta como LECTURA.
 *
 * Una consulta de lectura, entera. De una de escritura, **solo su `WHERE`**:
 *
 *  - El `WHERE` sí es un lector, y éste es el aprendizaje de #698:
 *    `UPDATE conversations SET unattended_alerted_at = $3 WHERE
 *    unattended_alerted_at IS NULL` es exactamente cómo se consigue que un
 *    aviso salga UNA vez. La columna se está leyendo ahí, aunque no haya
 *    ningún `SELECT`.
 *  - El `SET` no, obviamente: es la escritura.
 *  - El `RETURNING *` tampoco. Que la fila vuelva no significa que alguien la
 *    mire, y ése fue exactamente el caso de `won_at` (#695): el `UPDATE` la
 *    devolvía y el mapeador no la tocaba.
 */
function parteQueLee(consulta: string): string {
  const esEscritura = /^\s*(INSERT|UPDATE|DELETE)\b/i.test(consulta.trim());
  if (!esEscritura) return consulta;
  const sinReturning = consulta.replace(/\bRETURNING\b[\s\S]*$/i, '');
  const where = /\bWHERE\b([\s\S]*)$/i.exec(sinReturning);
  // El `WHERE` de una subconsulta en el `SET` también es lectura: pedirle al
  // escáner que distinga eso sería pedirle que parsee SQL.
  return where ? where[1] : '';
}

/**
 * Qué columnas lee cada archivo, como `tabla.columna`.
 *
 * Pura y con los textos por parámetro para poder probarla: la guarda se cae
 * sola si el escáner deja de distinguir una escritura de una lectura, y eso no
 * se nota con el repo verde.
 *
 * **La tabla importa.** Hay tres `created_by` en tablas distintas, y una guarda
 * que solo mirara el nombre de la columna se pondría verde para las tres en
 * cuanto una sola tuviera lector — que es precisamente el error que viene a
 * cazar. Así que el archivo tiene que nombrar la tabla ADEMÁS de leer la
 * columna: en este repo la consulta y su mapeador viven juntos, así que esa
 * cercanía es señal y no casualidad.
 */
export function lecturasPorTabla(
  columnas: ReadonlyArray<Columna>,
  textos: string[],
): Set<string> {
  const leidas = new Set<string>();
  const porTabla = new Map<string, Columna[]>();
  for (const c of columnas) {
    const lista = porTabla.get(c.tabla) ?? [];
    lista.push(c);
    porTabla.set(c.tabla, lista);
  }

  for (const bruto of textos) {
    const texto = fuenteLimpia(bruto);
    const tablas = [...porTabla.keys()].filter((t) => new RegExp(`\\b${t}\\b`).test(texto));
    if (tablas.length === 0) continue;

    const enEsteArchivo = new Set<string>();
    for (const consulta of consultas(texto)) {
      for (const m of parteQueLee(consulta).matchAll(/\b([a-z_][a-z0-9_]*)\b/g)) {
        enEsteArchivo.add(m[1]);
      }
    }
    // `row.created_at`: leer la fila de un `SELECT *` es leer la columna.
    for (const m of texto.matchAll(/\.([a-z_][a-z0-9_]*)\b/g)) enEsteArchivo.add(m[1]);
    // `createdAt` en un DTO, que es el otro extremo del mismo viaje.
    for (const m of texto.matchAll(/\b([a-z][a-zA-Z0-9]*)\b/g)) enEsteArchivo.add(aSnake(m[1]));

    for (const tabla of tablas) {
      for (const c of porTabla.get(tabla)!) {
        if (enEsteArchivo.has(c.columna)) leidas.add(`${tabla}.${c.columna}`);
      }
    }
  }
  return leidas;
}

/**
 * Las columnas declaradas que nadie lee, como `tabla.columna`.
 *
 * Los `tests/` quedan fuera a propósito: una prueba que afirma que la columna se
 * escribió no la convierte en algo que el producto use, y dejarlas dentro haría
 * que la guarda se pusiera verde escribiendo una prueba. Las migraciones
 * también: son la escritura.
 */
/**
 * `updated_at` queda fuera de la medición, y es la única excepción por regla.
 *
 * Es una marca operativa que la plataforma mantiene sola —`updated_at = now()`
 * en cada escritura— y que ninguna pantalla muestra. Hay una por tabla de
 * negocio: pedirle un lector a cada una serían diecisiete entradas diciendo lo
 * mismo, y una lista con diecisiete entradas de ruido enseña a no mirar la
 * lista. `created_at` NO queda fuera: «desde cuándo existe esto» es información
 * que el producto sí muestra, y las que no tienen lector son pocas y reales.
 */
const MARCA_OPERATIVA = (columna: string): boolean => columna === 'updated_at';

export function columnasSinLector(
  raices: string[],
  fuentes: string[],
  filtro: (columna: string) => boolean = () => true,
): string[] {
  const columnas = columnasDeclaradas(raices, (c) => !MARCA_OPERATIVA(c) && filtro(c));
  const textos = fuentes
    .flatMap((r) => archivos(r, /\.tsx?$/))
    .filter((f) => !/[/\\]tests?[/\\]/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => readFileSync(f, 'utf8'));
  const leidas = lecturasPorTabla(columnas, textos);
  return columnas
    .map((c) => `${c.tabla}.${c.columna}`)
    .filter((nombre) => !leidas.has(nombre));
}
