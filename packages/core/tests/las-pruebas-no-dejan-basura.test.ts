import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fuenteLimpia } from '../src/testing/fuente-limpia';

/**
 * Guarda: una prueba que crea un directorio temporal lo borra.
 *
 * No es higiene: llegué a **2168 directorios `iaxti-*` y más de 600 MB** en el
 * tmpfs, y lo que se rompió no fue una prueba sino la máquina, a mitad de otra
 * cosa — los procesos empezaron a fallar con ENOSPC y la salida de los comandos se
 * perdía. Seis archivos creaban directorios y ninguno los borraba;
 * `combinations.test.ts` además copia el árbol de módulos entero, una vez por
 * módulo y por corrida.
 *
 * El fallo aparece lejísimos de la causa, y eso es lo que lo hace caro: nadie
 * sospecha de una prueba que pasa en verde desde hace meses.
 */

const RAIZ = join(__dirname, '..', '..', '..');

/**
 * `CREATE OR REPLACE FUNCTION` incluido: reemplazar una función que ya existe es
 * peor todavía, porque la deja cambiada para todo el mundo.
 *
 * `CONSTRAINT TRIGGER` y `PROCEDURE` los trajo #924, y los dos faltaban: la
 * expresión que había acá pedía `TRIGGER` o `FUNCTION` pegados al `CREATE`, así
 * que un `CREATE CONSTRAINT TRIGGER` —que es un trigger y queda igual de
 * compartido— pasaba sin que nadie se enterara. Una guarda a la que se le
 * escapa la variante que alguien va a escribir mañana no es media guarda: es
 * una guarda en la que se confía de más.
 */
const DDL = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?(?:TRIGGER|FUNCTION|PROCEDURE)\b/i;
const RENAME = /ALTER\s+TABLE\s+\S+\s+RENAME\b/i;

/**
 * ¿Esta fuente crea un objeto en el esquema compartido?
 *
 * Los comentarios no crean nada: sin limpiarlos, `arranque.test.ts` aparecería
 * acusado por EXPLICAR —en el comentario que dejó #913— que antes renombraba la
 * tabla. Una guarda que acusa a quien documenta cómo dejó de hacerlo enseña a no
 * documentarlo.
 *
 * Pero la limpieza se hace con `fuenteLimpia` (#569) y no a mano. Lo que había
 * acá era un `replace(/^\s*\/\/.*$/gm, '')`, que es exactamente la copia
 * ingenua que ese helper existe para que nadie vuelva a escribir —parte al
 * medio cualquier `https://` y no sabe si el `//` vive dentro de un string—.
 * Treinta archivos tenían su versión; este era el trigésimo primero.
 */
export function creaObjetoCompartido(fuente: string): boolean {
  const limpia = fuenteLimpia(fuente);
  return DDL.test(limpia) || RENAME.test(limpia);
}

function archivosDePrueba(dir: string, encontrados: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    // `node_modules` y las salidas de build no son nuestras.
    // `.claude` guarda copias del repo (worktrees de agentes): no son fuente
    // nuestra y las encontraría dos veces.
    if (['node_modules', 'dist', '.next', '.turbo', '.git', '.claude'].includes(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) archivosDePrueba(ruta, encontrados);
    else if (/\.test\.(ts|mts|mjs)$/.test(entrada)) encontrados.push(ruta);
  }
  return encontrados;
}

describe('las pruebas no dejan basura en el disco', () => {
  it('toda prueba que crea un temporal lo borra', () => {
    const archivos = archivosDePrueba(RAIZ);
    // Primero: que el escáner encuentre algo. Uno que no ve ningún archivo pasa
    // siempre, y es peor que no tenerlo.
    expect(archivos.length).toBeGreaterThan(20);

    const sinLimpiar = archivos.filter((ruta) => {
      const fuente = readFileSync(ruta, 'utf8');
      if (!fuente.includes('mkdtempSync')) return false;
      return !fuente.includes('rmSync');
    });
    expect(
      sinLimpiar.map((r) => r.slice(RAIZ.length + 1)),
      'Estas pruebas crean un directorio temporal y no lo borran. Con el tiempo ' +
        'llenan el tmpfs y rompen corridas que no tienen nada que ver.',
    ).toEqual([]);
  });

  /**
   * La otra basura: la que queda en la BASE (#910, #804, #913).
   *
   * Una prueba que necesita que una escritura falle tenía dos formas de
   * conseguirlo, y las dos tocaban el esquema compartido: crear un trigger que
   * lanza, o renombrar la tabla. Con un `finally` parece controlado, pero el
   * `finally` no corre si el proceso muere en el medio —Ctrl-C, OOM, el
   * timeout de la suite— y entonces el trigger se queda en la base para
   * siempre, apuntando a un tenant que ya no existe. Nada falla y nadie se
   * entera, que es la forma más cara de romper algo.
   *
   * Y mientras la ventana está abierta, el objeto es de TODAS las conexiones:
   * los 60 y pico de archivos que vitest corre en paralelo contra la misma
   * base lo ven. En #913 eso dejó rojos prestados en otros archivos.
   *
   * La forma correcta es provocar el fallo donde NACE la consulta: desviar el
   * nombre de la tabla en el texto que sale por ESA conexión. El error lo
   * sigue poniendo Postgres —así la transacción se aborta de verdad— y el
   * catálogo no se toca. Hay dos ejemplos para copiar:
   * `payments/tests/aviso-de-pago.test.ts` y
   * `workers/tests/outbound-vigencia.test.ts`.
   *
   * Lo que NO entra acá: `sinTriggers` (#803), que apaga los triggers de la
   * SESIÓN con `session_replication_role` y no deja nada atrás.
   */
  it('ninguna prueba crea triggers ni funciones en el esquema compartido', () => {
    const archivos = archivosDePrueba(RAIZ);
    expect(archivos.length).toBeGreaterThan(20);

    /**
     * La excepción, con su motivo: crea su PROPIA tabla para probar que
     * `sinTriggers` (#803) apaga triggers de verdad, y la deja caer con
     * `DROP … CASCADE`. No toca ninguna tabla del producto, y como empieza con
     * `DROP IF EXISTS`, un proceso muerto a medias se arregla solo en la
     * corrida siguiente.
     */
    const CON_SU_PROPIA_TABLA = ['packages/db/tests/sin-triggers.test.ts'];

    /**
     * Y la excepción que se destapó al escribir la mordida de abajo: ESTE
     * archivo lleva los `CREATE TRIGGER …` de prueba en strings, a propósito,
     * y `fuenteLimpia` conserva lo que vive dentro de un string —tiene que
     * conservarlo, porque el SQL de las pruebas de verdad también viaja ahí—.
     * Así que al agregar los casos, la guarda se acusó a sí misma.
     *
     * Se podría disimular armando el SQL por pedazos
     * (`['CREATE','TRIGGER'].join(' ')`) y quedaría «verde». Eso es justo lo
     * que no hay que hacer: el día que alguien escriba DDL de verdad acá, el
     * mismo truco lo taparía. Mejor la excepción escrita, con su motivo, que
     * una regla que se esquiva con comillas.
     */
    const LOS_CASOS_DE_ESTA_GUARDA = ['packages/core/tests/las-pruebas-no-dejan-basura.test.ts'];

    /**
     * Y la excepción más fuerte que «su propia tabla»: SU PROPIA BASE.
     *
     * `google-cleanup.test.ts` hace `CREATE DATABASE iaxti_google_cleanup_<hex>`
     * en su `beforeAll` y la bota en el `afterAll`. El trigger que crea para
     * forzar un fallo de `DELETE` nace y muere ahí dentro: ninguna otra conexión
     * del repositorio se conecta a esa base, así que los dos daños que esta
     * guarda existe para evitar no son posibles —no lo ven los archivos que
     * corren en paralelo, y si el proceso muere a medias se va con la base, no
     * queda apuntando a un tenant que ya no existe—.
     *
     * Queda como excepción escrita y no como regla automática a propósito. Un
     * `CREATE DATABASE` en el archivo NO prueba que el DDL vaya a esa base: el
     * mismo archivo tiene dos pools (`control` apunta a la compartida y `admin`
     * a la propia), y desde la fuente no se puede saber cuál se usó. Una regla
     * que dedujera «tiene CREATE DATABASE, entonces está limpio» dejaría pasar
     * justo el caso que importa.
     */
    const CON_SU_PROPIA_BASE = ['packages/modules/calendar/tests/google-cleanup.test.ts'];

    const culpables = archivos.filter((ruta) => {
      const relativa = ruta.slice(RAIZ.length + 1);
      if (CON_SU_PROPIA_TABLA.includes(relativa)) return false;
      if (LOS_CASOS_DE_ESTA_GUARDA.includes(relativa)) return false;
      if (CON_SU_PROPIA_BASE.includes(relativa)) return false;
      return creaObjetoCompartido(readFileSync(ruta, 'utf8'));
    });
    expect(
      culpables.map((r) => r.slice(RAIZ.length + 1)),
      'Estas pruebas crean objetos en el esquema de la base compartida. Si el ' +
        'proceso muere antes del `finally`, quedan ahí para siempre; y mientras ' +
        'existen, los ven todos los archivos que corren en paralelo. Para ' +
        'provocar un fallo de escritura, desvía el nombre de la tabla en el ' +
        'texto de la consulta de ESA conexión (#910).',
    ).toEqual([]);
  });

  /**
   * La guarda se muerde a sí misma.
   *
   * Un escáner de texto se puede romper sin que nada se ponga rojo: alcanza con
   * que la expresión deje de calzar. Ya pasó en este repositorio —un `\b`
   * escrito desde un heredoc de Python llegó al archivo como un byte 0x08 y
   * desactivó la regex en silencio—, y el modo de falla es el peor que hay: la
   * lista de culpables sale vacía y eso se lee como «no hay culpables».
   *
   * Así que la detección tiene sus propios casos. Los tres primeros los trajo
   * #924, que es donde apareció lo de `CONSTRAINT TRIGGER`.
   */
  it.each([
    'CREATE TRIGGER falla BEFORE INSERT ON outbox EXECUTE FUNCTION falla()',
    'CREATE OR REPLACE FUNCTION falla() RETURNS trigger LANGUAGE plpgsql',
    'CREATE CONSTRAINT TRIGGER falla AFTER UPDATE ON messages',
    'CREATE PROCEDURE romper() LANGUAGE plpgsql',
    'ALTER TABLE outbox RENAME TO outbox_viejo',
  ])('detecta el DDL que se quiere evitar: %s', (sql) => {
    expect(creaObjetoCompartido(`await cliente.query(${JSON.stringify(sql)});`)).toBe(true);
  });

  it('no acusa a quien lo explica en un comentario', () => {
    expect(
      creaObjetoCompartido(
        '// antes hacía CREATE TRIGGER falla …\n/* y también ALTER TABLE outbox RENAME TO x */\nawait cliente.query("SELECT 1");',
      ),
    ).toBe(false);
  });

  it('no parte una URL con dos barras, que es lo que rompía la limpieza a mano', () => {
    const fuente = 'const doc = "https://ejemplo/doc"; await cliente.query("CREATE TRIGGER t …");';
    expect(creaObjetoCompartido(fuente)).toBe(true);
  });
});
