import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { archivosFuente } from './testing/archivos';
import { fuenteLimpia } from './testing/fuente-limpia';

/**
 * Qué módulo consulta las tablas de qué otro (#784).
 *
 * ## La regla que estaba escrita no era la regla
 *
 * `.claude/rules/db.md` decía, sin matices, «consultas de otro módulo:
 * prohibidas». Medido el 14/10 —cada tabla atribuida al módulo cuya migración
 * la crea, y los `FROM`/`JOIN`/`UPDATE`/`INSERT INTO`/`DELETE FROM` del código
 * de cada módulo— **cruzan 35 pares de módulos**, y 16 de esos pares cruzan
 * hacia algo que YA declaran en `depends_on`.
 *
 * O sea que lo prohibido era la práctica mayoritaria del repo. Y eso es peor
 * que no tener regla: mientras esté escrita, cada PR elige entre romperla o
 * pagar un refactor que nadie pidió —y lo que se elige, con razón, es
 * romperla—. La segunda vez que se rompe a propósito, ya nadie la lee.
 *
 * También hay que decir qué NO era: los 35 pares no están mal. Un segmento de
 * CRM filtrado por etapa de oportunidad es legítimamente una consulta que
 * cruza; hacerla por contrato sería traer todos los contactos a memoria y
 * filtrar en TypeScript, que es peor por donde se lo mire.
 *
 * Así que la regla escrita es ahora la que se puede sostener: **cruzar hacia un
 * módulo que declarás en `depends_on` está permitido; hacia uno que no
 * declarás, no**. El manifiesto es la documentación del cruce —quien quiera
 * saber de qué esquemas depende un módulo lo lee ahí y no grepeando SQL— y esta
 * guarda es lo que impide que los pares SIN declarar crezcan en silencio.
 *
 * ## Por qué el par y no el archivo
 *
 * El issue contó 82 archivos, y ése es el número que asusta sin decir nada: el
 * mismo cruce repartido en ocho archivos sigue siendo UNA dependencia entre dos
 * módulos, y es la que se puede revisar en un PR —«`automations` ahora depende
 * del esquema de `crm`: sí o no»—. Por eso el trinquete cuenta pares: 35 hoy,
 * 19 de ellos sin declarar, que son las entradas de la lista base.
 *
 * ## Y por qué la marca `lee` / `escribe`
 *
 * Porque no tienen la misma consecuencia, y ésa es la distinción que la regla
 * vieja no hacía. Un `SELECT` que cruza es una dependencia de LECTURA sobre un
 * esquema ajeno: molesta el día que ese módulo migre. Un `UPDATE` o un `INSERT`
 * rompe sus invariantes y su auditoría sin pasar por su código, que es un daño
 * de otra clase. La marca va dentro del nombre de la entrada a propósito: un
 * par que hoy lee y mañana escribe aparece como entrada NUEVA, y hay que
 * justificarlo, en vez de colarse dentro de una excepción ya concedida.
 *
 * ## Lo que esto NO mira, y por qué
 *
 *  - `packages/db/migrations` crea `outbox`, `idempotency_keys` y
 *    `processed_events`: infraestructura que no es de ningún módulo. Una tabla
 *    sin dueño no es un cruce, así que el outbox no aparece acá. `tenants` la
 *    crea también, pero `organizations` la declara en su propia migración y
 *    gana el módulo: leer `tenants` ES cruzar hacia `organizations`.
 *  - Las pruebas. El `INSERT` de un fixture en la tabla de otro módulo no es
 *    acoplamiento del producto, y dejarlas dentro llenaría la lista de ruido
 *    —que es como se enseña a no mirar una lista—.
 *  - El SQL armado por concatenación o con el nombre de la tabla interpolado
 *    (`FROM ${tabla}`): esto lee texto, no ejecuta. A quien quiera esconder un
 *    cruce le alcanza una interpolación; el punto es que quien lo escriba sin
 *    querer no se esconda solo.
 *  - Lo que el módulo cruza por CONTRATO (un import de `@iaxti/module-crm`).
 *    Eso ya tiene su guarda en `dependencias-declaradas.ts` (#821), que mira
 *    imports y no tablas, y las dos miden cosas distintas a propósito: un
 *    import se rompe al compilar cuando el otro módulo cambia, y un `JOIN` a su
 *    tabla no se rompe hasta producción.
 */

/** Una tabla que un archivo nombra en posición de tabla, y cómo la toca. */
export interface TablaConsultada {
  tabla: string;
  /** `UPDATE`, `INSERT INTO` o `DELETE FROM`; un `FROM`/`JOIN` es solo lectura. */
  escribe: boolean;
}

/** Un módulo tal como lo necesita el escáner: su id, su árbol y su `depends_on`. */
export interface ModuloQueConsulta {
  id: string;
  dir: string;
  /** `required` + `optional` juntas: las dos documentan el cruce. */
  declaradas: string[];
}

/** Un módulo consultando las tablas de otro, con todo lo medido del par. */
export interface Cruce {
  modulo: string;
  dueno: string;
  /** El `dueno` está en el `depends_on` del módulo que lo consulta. */
  declarado: boolean;
  /** Alguna de las consultas del par escribe, no solo lee. */
  escribe: boolean;
  tablas: string[];
  archivos: string[];
}

/**
 * Las posiciones de SQL donde lo que sigue es el nombre de una tabla.
 *
 * `DELETE\s+FROM` tiene que estar en la alternancia, y no alcanza con `FROM`:
 * el verbo capturado es lo único que después dice si el par escribe o solo
 * lee, y un borrado en la tabla de otro módulo no es una lectura. (El ORDEN de
 * las alternativas no importa: la coincidencia más a la izquierda gana, y
 * `DELETE` empieza antes que su propio `FROM`.)
 */
const EN_POSICION_DE_TABLA =
  /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE|FROM|JOIN)\s+(?:ONLY\s+)?"?([a-z_][a-z0-9_]*)"?/gi;

/** Las cadenas que tienen SQL escrito, no prosa que casualmente dice «from». */
const TIENE_SQL = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN)\b/i;

/**
 * El SQL que hay escrito en un archivo: plantillas y comillas simples.
 *
 * `FROM` también cuenta como señal de SQL —y no solo los verbos— porque este
 * repo parte consultas largas en varias cadenas, y el fragmento que trae el
 * `JOIN` puede no traer ningún `SELECT`. Mirar solo los verbos dejaba ese
 * pedazo afuera, que es exactamente donde vive la tabla ajena.
 */
function sentencias(codigo: string): string[] {
  const todas: string[] = [];
  for (const m of codigo.matchAll(/`([^`]*)`|'([^'\n]*)'/g)) {
    const texto = m[1] ?? m[2] ?? '';
    if (TIENE_SQL.test(texto)) todas.push(texto);
  }
  return todas;
}

/**
 * Qué tablas nombra un archivo fuente, y si las escribe.
 *
 * Pura y con el texto por parámetro para poder probarla: una guarda cuyo
 * escáner deja de distinguir un `DELETE FROM` de un `FROM` se pone verde sola,
 * y eso no se nota con el repo en verde.
 */
export function tablasQueConsulta(fuente: string): TablaConsultada[] {
  const escrituraPorTabla = new Map<string, boolean>();
  for (const sentencia of sentencias(fuenteLimpia(fuente))) {
    for (const m of sentencia.matchAll(EN_POSICION_DE_TABLA)) {
      const escribe = /^(INSERT|UPDATE|DELETE)/i.test(m[1]);
      escrituraPorTabla.set(m[2], (escrituraPorTabla.get(m[2]) ?? false) || escribe);
    }
  }
  return [...escrituraPorTabla.entries()]
    .map(([tabla, escribe]) => ({ tabla, escribe }))
    .sort((a, b) => a.tabla.localeCompare(b.tabla));
}

/**
 * Qué módulo es dueño de cada tabla: el que la crea en su migración.
 *
 * Los módulos se recorren ORDENADOS porque dos migraciones pueden crear la
 * misma tabla con `IF NOT EXISTS` —`tenants` es el caso— y el dueño tiene que
 * salir siempre el mismo, no el que `readdirSync` devuelva primero en esta
 * máquina. Una guarda cuyo resultado depende del orden del sistema de archivos
 * es una guarda que falla en CI y pasa en local.
 */
export function duenosDeTabla(raizModulos: string): Map<string, string> {
  const duenos = new Map<string, string>();
  for (const modulo of readdirSync(raizModulos).sort()) {
    const migraciones = join(raizModulos, modulo, 'migrations');
    if (!existsSync(migraciones)) continue;
    for (const sql of archivosFuente(migraciones, { extension: /\.sql$/ })) {
      // Sin los comentarios de SQL: una migración que explica por qué NO crea
      // una tabla la nombra igual, y ahí se inventaría un dueño.
      const texto = readFileSync(sql, 'utf8').replace(/--[^\n]*/g, '');
      for (const m of texto.matchAll(
        /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi,
      )) {
        if (!duenos.has(m[1])) duenos.set(m[1], modulo);
      }
    }
  }
  return duenos;
}

/** El nombre con el que un cruce entra en la lista base. */
export function nombreDelCruce(cruce: Cruce): string {
  return `${cruce.modulo}→${cruce.dueno} (${cruce.escribe ? 'escribe' : 'lee'})`;
}

/** Todos los pares módulo → dueño que consultan tablas ajenas. */
export function crucesEntreModulos(
  modulos: ReadonlyArray<ModuloQueConsulta>,
  duenos: Map<string, string>,
): Cruce[] {
  const pares = new Map<string, Cruce>();
  for (const modulo of modulos) {
    for (const archivo of archivosFuente(modulo.dir)) {
      for (const { tabla, escribe } of tablasQueConsulta(readFileSync(archivo, 'utf8'))) {
        const dueno = duenos.get(tabla);
        if (dueno === undefined || dueno === modulo.id) continue;
        const clave = `${modulo.id}→${dueno}`;
        const cruce =
          pares.get(clave) ??
          ({
            modulo: modulo.id,
            dueno,
            declarado: modulo.declaradas.includes(dueno),
            escribe: false,
            tablas: [],
            archivos: [],
          } satisfies Cruce);
        cruce.escribe = cruce.escribe || escribe;
        if (!cruce.tablas.includes(tabla)) cruce.tablas.push(tabla);
        if (!cruce.archivos.includes(archivo)) cruce.archivos.push(archivo);
        pares.set(clave, cruce);
      }
    }
  }
  for (const cruce of pares.values()) {
    cruce.tablas.sort();
    cruce.archivos.sort();
  }
  return [...pares.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, cruce]) => cruce);
}

/**
 * Los nombres de los pares que consultan tablas de un módulo que NO declaran.
 *
 * Esto es lo que la lista base congela: los cruces declarados están permitidos
 * por la regla y no se listan —listar lo permitido sería una lista que nadie
 * revisa—, y éstos son los que no pueden ser uno más mañana.
 *
 * Recibe los cruces YA medidos en vez de volver a escanear: la guarda necesita
 * el total y los sin declarar en la misma corrida, y dos barridos del repo por
 * guarda es el costo que la pone sobre los 5 s de vitest con la máquina
 * cargada (#776). Que el filtro viva acá y no en cada llamador es lo que
 * mantiene UNA sola definición de qué entra en la lista.
 */
export function crucesSinDeclarar(cruces: ReadonlyArray<Cruce>): string[] {
  return cruces.filter((cruce) => !cruce.declarado).map(nombreDelCruce);
}
