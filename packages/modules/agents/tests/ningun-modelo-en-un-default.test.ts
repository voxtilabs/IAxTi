import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RESPALDO_POR_PROVEEDOR, DEFAULT_TASK_MODELS } from '../domain/config';

/**
 * Ningún nombre de modelo vive en un sitio que nadie revalida (#861).
 *
 * Lo que costó: `0001` dejó `model text NOT NULL DEFAULT 'gemini-2.5-flash'`,
 * y ése es exactamente el modelo que el propio repo registra como retirado —
 * `404 · This model models/gemini-2.5-flash is no longer available to new
 * users`, anotado en el comentario de `domain/config.ts`.
 *
 * O sea que el valor por defecto de la base apuntaba a un modelo que no
 * existe, y se quedó ahí meses.
 *
 * ## Por qué un DEFAULT es el peor lugar posible
 *
 * **Porque no se vuelve a leer nunca.** Un nombre de modelo en el código lo ve
 * quien pasa por ahí; uno en un `DEFAULT` aparece solo el día que alguien
 * inserta sin nombrarlo, y ese día ya es tarde. Envejece en silencio, que es
 * la familia de defectos entera de esta semana en su forma más tranquila.
 *
 * La guarda, entonces, no vigila un nombre: vigila el LUGAR.
 */
const MIGRACIONES = join(__dirname, '..', 'migrations');

/** Los nombres de modelo que el producto conoce, de las dos fuentes que mandan. */
const CONOCIDOS = new Set<string>([
  ...Object.values(DEFAULT_TASK_MODELS).map((m) => m.model),
  ...Object.values(RESPALDO_POR_PROVEEDOR).flatMap((g) => [g.liviano, g.pesado]),
]);

/**
 * Cómo se reconoce un nombre de modelo sin tener una lista que envejezca.
 *
 * Por la FORMA, no por el nombre: las familias que el producto usa se llaman
 * todas igual —una palabra, un número con punto, a veces un sufijo o un
 * prefijo de organización—. Esto reconoce `gemini-2.5-flash`, `gpt-5-mini`,
 * `claude-haiku-4-5-20251001` y `z-ai/glm-5.3-flash` sin nombrar ninguno.
 *
 * Es deliberadamente generoso: un falso positivo se resuelve nombrando el
 * modelo en otra parte, y un falso negativo deja volver el defecto.
 */
const PARECE_UN_MODELO =
  /\b(?:[a-z0-9-]+\/)?(?:gpt|gemini|claude|glm|llama|mistral|command|nova|grok|deepseek|qwen)[a-z0-9.-]*\b/i;

describe('ningún nombre de modelo en un DEFAULT de migración (#861)', () => {
  const archivos = readdirSync(MIGRACIONES).filter((f) => f.endsWith('.sql'));

  it('la guarda está mirando algo', () => {
    // Anti-vacuidad por los dos lados: si no hubiera migraciones, o si la
    // expresión no reconociera los modelos que el producto usa de verdad,
    // esto pasaría sin medir nada.
    expect(archivos.length).toBeGreaterThan(10);
    expect(CONOCIDOS.size).toBeGreaterThan(3);
    for (const m of CONOCIDOS) {
      expect(PARECE_UN_MODELO.test(m), `la guarda no reconoce "${m}" como modelo`).toBe(true);
    }
  });

  /**
   * La regla no es «nunca hubo un modelo en un DEFAULT»: las migraciones son
   * SOLO aditivas, así que `0001` no se edita y su historia queda.
   *
   * La regla es: **si hubo, una migración posterior lo quitó.** Eso convierte
   * la guarda en algo que se puede cumplir sin reescribir el pasado, y deja
   * la puerta cerrada para el próximo que lo intente.
   */
  it('todo DEFAULT con nombre de modelo fue quitado por una migración posterior', () => {
    const sinComentarios = (sql: string) =>
      sql
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('--'))
        .join('\n');

    // Los comentarios de estas migraciones CUENTAN la historia y nombran los
    // modelos retirados a propósito. Mirarlos haría que la guarda se ponga
    // roja por el texto que la explica — pasó cinco veces en este repo, y por
    // eso existe `fuenteLimpia`.
    const todoElSql = archivos
      .map((f) => sinComentarios(readFileSync(join(MIGRACIONES, f), 'utf8')))
      .join('\n');

    /** `model text NOT NULL DEFAULT 'gemini-2.5-flash'` → la columna es `model`. */
    const conModelo: Array<{ archivo: string; columna: string; valor: string }> = [];
    for (const archivo of archivos) {
      const sql = sinComentarios(readFileSync(join(MIGRACIONES, archivo), 'utf8'));
      for (const linea of sql.split('\n')) {
        const m = /^\s*([a-z_]+)\s+[a-z]/i.exec(linea);
        const d = /DEFAULT\s+'([^']+)'/i.exec(linea);
        if (m && d && PARECE_UN_MODELO.test(d[1])) {
          conModelo.push({ archivo, columna: m[1], valor: d[1] });
        }
      }
    }

    // Anti-vacuidad: si el escáner dejara de encontrarlos, el bucle de abajo
    // pasaría sin medir nada — y el caso histórico de `0001` existe, así que
    // encontrar cero significa que el escáner se rompió.
    expect(conModelo.length).toBeGreaterThan(0);

    const sinArreglar = conModelo.filter(
      (c) => !new RegExp(`ALTER COLUMN ${c.columna} DROP DEFAULT`, 'i').test(todoElSql),
    );
    expect(
      sinArreglar.map((c) => `${c.archivo}: ${c.columna} DEFAULT '${c.valor}'`),
      'Estos DEFAULT fijan un nombre de modelo y ninguna migración posterior los quita. Un ' +
        'DEFAULT no se vuelve a leer nunca, así que el nombre envejece sin que nadie se entere: ' +
        'fue el caso de `gemini-2.5-flash` en 0001, retirado y por defecto durante meses, con ' +
        'dos pruebas heredándolo y `evaluation.ts` corriendo el dataset contra un 404. El ' +
        'modelo lo elige la aplicación desde `DEFAULT_TASK_MODELS`, que sí se mira.\n  ' +
        sinArreglar.map((c) => `${c.archivo}: ${c.columna}`).join('\n  '),
    ).toEqual([]);
  });

  it('y la columna de agents no tiene default, que es lo que 0015 vino a quitar', () => {
    const todo = archivos.map((f) => readFileSync(join(MIGRACIONES, f), 'utf8')).join('\n');
    // La migración aditiva que lo quita tiene que existir: sin ella, una base
    // creada desde cero volvería a nacer con el default retirado.
    expect(todo).toMatch(/ALTER TABLE agents ALTER COLUMN model DROP DEFAULT/i);
    expect(todo).toMatch(/ALTER TABLE agents ALTER COLUMN provider DROP DEFAULT/i);
  });
});
