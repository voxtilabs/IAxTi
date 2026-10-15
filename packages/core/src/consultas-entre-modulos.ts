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
 * Así que la regla escrita es ahora la que se puede sostener, y tiene DOS
 * mitades con alcance distinto —la recomendación «1 + 2» del issue—:
 *
 *  - **LEER** las tablas de un módulo que declarás en `depends_on` está
 *    permitido; leer las de uno que no declarás, no. El manifiesto es la
 *    documentación del cruce: quien quiera saber de qué esquemas depende un
 *    módulo lo lee ahí y no grepeando SQL.
 *  - **ESCRIBIR** en la tabla de otro módulo (`UPDATE`, `INSERT`, `DELETE`) no
 *    se permite, lo declares o no. Declarar dice «dependo de este esquema», y
 *    eso no alcanza para escribirlo: el `depends_on` no te da sus invariantes
 *    ni su auditoría. Por eso la lista base lleva TAMBIÉN las escrituras hacia
 *    módulos declarados —hoy tres— en vez de dejarlas pasar por declaradas.
 *
 * Esta guarda es lo que impide que cualquiera de las dos crezca en silencio.
 *
 * ## Por qué el par y no el archivo
 *
 * El issue contó 82 archivos, y ése es el número que asusta sin decir nada: el
 * mismo cruce repartido en ocho archivos sigue siendo UNA dependencia entre dos
 * módulos, y es la que se puede revisar en un PR —«`automations` ahora depende
 * del esquema de `crm`: sí o no»—. Por eso el trinquete cuenta pares: 35 hoy,
 * 22 de ellos fuera de la regla, que son las entradas de la lista base.
 *
 * Los archivos igual se cuentan, porque el issue pide medir «cuántos de los 82
 * son escrituras» y ése es su criterio de aceptación 2: `medicionDeCruces` da
 * los dos números —pares y consultas archivo-tabla— partidos por lectura y
 * escritura. Medido el 14/10: **81 consultas archivo-tabla cruzan y 13 son
 * escrituras**, repartidas en 10 de los 35 pares. O sea que la línea «leer sí,
 * escribir no» ya está casi respetada, que es justo lo que el issue quería
 * saber antes de elegir qué regla escribir: prohibir las escrituras cuesta 10
 * entradas, no 35.
 *
 * (El issue decía 82 y acá salen 81. La diferencia está medida, no estimada:
 * su búsqueda era un grep sobre el archivo crudo, y la de más es
 * `payments/application/links.ts:227`, un COMENTARIO que dice
 * «el correo sale del CONTRATO de crm y no de un `SELECT email FROM
 * contacts`». Una guarda que contara eso contaría como cruce justamente la
 * frase que explica que no hay cruce — la lección de #569, que acá la paga
 * `fuenteLimpia`.)
 *
 * ## Y por qué la marca `lee` / `escribe`
 *
 * Porque no tienen la misma consecuencia, y ésa es la distinción que la regla
 * vieja no hacía. Un `SELECT` que cruza es una dependencia de LECTURA sobre un
 * esquema ajeno: molesta el día que ese módulo migre. Un `UPDATE` o un `INSERT`
 * rompe sus invariantes y su auditoría sin pasar por su código, que es un daño
 * de otra clase —y por eso una escritura entra en la lista aunque el módulo
 * esté declarado—. La marca va dentro del nombre de la entrada a propósito: un
 * par que hoy lee y mañana escribe aparece como entrada NUEVA, y hay que
 * justificarlo, en vez de colarse dentro de una excepción ya concedida.
 *
 * ## Y por qué las TABLAS también van en el nombre
 *
 * Porque si no, una entrada ya concedida absorbe crecimiento sin límite:
 * `platform→agents (lee)` cubría tres tablas, y treinta el día de mañana, sin
 * que la marca se moviera ni nadie mirara. El par sigue siendo la unidad de la
 * DECISIÓN —se concede un cruce entre dos módulos, no una tabla—, pero el
 * alcance concedido es el que estaba medido cuando se concedió. Tocar una
 * cuarta tabla de `agents` es ampliar esa dependencia, y amplía la entrada: la
 * llave cambia, el motivo viejo deja de calzar y hay que volver a escribirlo.
 * `--escribir` imprime el motivo anterior del mismo par para que ampliar sea
 * releer y editar una frase, no escribirla de cero.
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
  /**
   * Cuántas consultas archivo-tabla distintas tiene el par, y cuántas de ésas
   * escriben. Es la unidad en la que el issue contó los 82: el par dice cuántas
   * DEPENDENCIAS hay y esto dice cuánto código las sostiene, que son dos
   * preguntas distintas y las dos están en el criterio de aceptación.
   */
  consultas: number;
  escrituras: number;
}

/** El recuento que pedía el criterio 2 del issue, en sus dos unidades. */
export interface MedicionDeCruces {
  pares: number;
  paresQueEscriben: number;
  paresDeclarados: number;
  /** Consultas archivo-tabla: el número que el issue llamó «los 82». */
  consultas: number;
  escrituras: number;
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
 * El SQL que hay escrito en un archivo: las TRES formas de escribir una cadena.
 *
 * `FROM` también cuenta como señal de SQL —y no solo los verbos— porque este
 * repo parte consultas largas en varias cadenas, y el fragmento que trae el
 * `JOIN` puede no traer ningún `SELECT`. Mirar solo los verbos dejaba ese
 * pedazo afuera, que es exactamente donde vive la tabla ajena.
 *
 * La comilla DOBLE está por el mismo motivo, y antes faltaba. No era un caso
 * hipotético: `conversations/application/conversations.ts:573` tiene
 * `"SELECT * FROM messages WHERE … direction = 'out' FOR UPDATE"` entre
 * comillas dobles, y por el motivo de siempre —la consulta lleva adentro un
 * literal con comilla simple, así que escribirla con comilla doble ahorra
 * escapes—. Ésa no cambia ninguna cuenta porque `messages` es del propio
 * `conversations`, pero nada en el repo impide que la próxima cruce: no hay
 * formateador configurado ni regla de lint que fije las comillas. Y el modo de
 * falla de un punto ciego así es el peor: la guarda no se pone roja, se queda
 * corta.
 *
 * El orden de la alternancia importa: la plantilla va PRIMERO para que un
 * `FROM "messages"` dentro de un backtick se lea entero como una sentencia, en
 * vez de que la comilla doble del identificador abra una cadena falsa. Y el
 * ruido que la comilla doble pudiera traer (`"Elegí una opción from la lista"`)
 * no llega a la medición: lo que sigue a ese `from` tiene que ser el nombre de
 * una tabla con dueño para contar como cruce.
 */
function sentencias(codigo: string): string[] {
  const todas: string[] = [];
  for (const m of codigo.matchAll(/`([^`]*)`|'([^'\n]*)'|"([^"\n]*)"/g)) {
    const texto = m[1] ?? m[2] ?? m[3] ?? '';
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
 * Los módulos se recorren ORDENADOS por el empate: el primero que crea una
 * tabla se queda de dueño (`if (!duenos.has(...))`), así que si dos MÓDULOS
 * crearan una con el mismo nombre, el dueño sería el que `readdirSync`
 * devolviera primero en esta máquina, y una guarda cuyo resultado depende del
 * orden del sistema de archivos falla en CI y pasa en local. Hoy ese empate no
 * existe —ninguna tabla la crean dos módulos— y el `.sort()` está para que el
 * día que exista se resuelva igual en todas partes.
 *
 * `tenants` NO es ese caso, aunque la tenga escrita dos veces: la otra
 * migración que la crea vive en `packages/db/migrations`, que este recorrido
 * ni siquiera abre —sólo baja por `raizModulos`—. Que su dueño sea
 * `organizations` no sale de este desempate sino de que la plataforma no es un
 * módulo.
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

/**
 * El nombre con el que un cruce entra en la lista base.
 *
 * Lleva el par, la marca y las tablas: las tres cosas que, al cambiar, cambian
 * la decisión que alguien tomó cuando concedió la entrada. Ver «por qué las
 * TABLAS también van en el nombre» arriba.
 */
export function nombreDelCruce(cruce: Cruce): string {
  const marca = cruce.escribe ? 'escribe' : 'lee';
  return `${cruce.modulo}→${cruce.dueno} (${marca}: ${cruce.tablas.join(', ')})`;
}

/** El par solo, sin marca ni tablas: la llave de «esta entrada ya existía». */
export function parDelCruce(nombre: string): string {
  return nombre.split(' (')[0];
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
            consultas: 0,
            escrituras: 0,
          } satisfies Cruce);
        cruce.escribe = cruce.escribe || escribe;
        // `tablasQueConsulta` ya devuelve una entrada por tabla y por archivo,
        // así que acá cada vuelta ES una consulta archivo-tabla distinta: es el
        // número que el issue contó como «los 82», y sumarlo acá es lo que
        // evita un segundo barrido del repo para medir lo mismo.
        cruce.consultas += 1;
        if (escribe) cruce.escrituras += 1;
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
 * Los nombres de los cruces que la regla NO permite, que es lo que la lista
 * base congela.
 *
 * Son dos clases, una por cada mitad de la regla:
 *
 *  - los que LEEN tablas de un módulo que no declaran en `depends_on`;
 *  - los que ESCRIBEN en tablas de otro módulo, lo declaren o no. Declarar
 *    documenta una dependencia de esquema; no reparte permiso de escritura
 *    sobre las invariantes del otro. Si esta función dejara pasar las
 *    escrituras declaradas, la guarda diría una regla y `db.md` otra — y la
 *    que gana siempre es la guarda, porque es la que se pone roja.
 *
 * Un cruce que lee lo que declara no se lista: listar lo permitido sería una
 * lista que nadie revisa.
 *
 * Recibe los cruces YA medidos en vez de volver a escanear: la guarda necesita
 * el total y los de la lista en la misma corrida, y dos barridos del repo por
 * guarda es el costo que la pone sobre los 5 s de vitest con la máquina
 * cargada (#776). Que el filtro viva acá y no en cada llamador es lo que
 * mantiene UNA sola definición de qué entra en la lista.
 */
export function crucesFueraDeLaRegla(cruces: ReadonlyArray<Cruce>): string[] {
  return cruces.filter((cruce) => !cruce.declarado || cruce.escribe).map(nombreDelCruce);
}

/**
 * Cuántos cruces hay y cuántos escriben, en las dos unidades (criterio 2).
 *
 * El issue pedía medir «cuántos de los 82 son ESCRITURAS», y eso no se podía
 * contestar con la lista base: la lista dice qué pares están fuera de la
 * regla, no cuánto código cruza ni qué parte de ese código escribe. Esto lo
 * deriva de la MISMA corrida del escáner —nada que volver a barrer, nada que
 * recalcular a mano cuando el repo cambie— y es lo que imprime el script.
 */
export function medicionDeCruces(cruces: ReadonlyArray<Cruce>): MedicionDeCruces {
  return {
    pares: cruces.length,
    paresQueEscriben: cruces.filter((c) => c.escribe).length,
    paresDeclarados: cruces.filter((c) => c.declarado).length,
    consultas: cruces.reduce((n, c) => n + c.consultas, 0),
    escrituras: cruces.reduce((n, c) => n + c.escrituras, 0),
  };
}
