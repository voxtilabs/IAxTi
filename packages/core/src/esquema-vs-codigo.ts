import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lo que el esquema acepta contra lo que el código produce (#1278).
 *
 * Es el trinquete de la clase de defecto que más caro salió en este repo:
 * **declarado en un lado, aplicado en ninguno**. El caso que lo motivó costó
 * mensajes de clientes. `TIPOS` en el adaptador de Zavu producía diez tipos de
 * mensaje; el `CHECK` de `messages.type` aceptaba ocho. Un video entrante
 * violaba la restricción, `withTenant` abortaba la transacción entera y se
 * perdían el mensaje, el contacto y la conversación —y `last_inbound_at` no
 * se movía, así que la ventana de 24 h nunca se abría. Nadie lo vio hasta que
 * alguien mandó un video en vivo.
 *
 * Ninguna prueba podía cazarlo: cada lado era correcto por separado. Lo que
 * estaba roto era la relación entre los dos, y una relación no tiene archivo.
 *
 * La guarda no pide un manifiesto que diga qué constante corresponde a qué
 * columna —una lista así se desactualiza igual que lo que vigila—. Busca en
 * todo el código las uniones y arrays de literales, y para cada `CHECK` avisa
 * del **solapamiento parcial**: si dos conjuntos comparten dos valores o más
 * pero no son iguales, alguien declaró lo mismo dos veces y una copia quedó
 * atrás. Es deliberadamente una heurística: la alternativa es no mirar.
 *
 * La dirección importa, y mucho:
 *
 * - **El código declara valores que el esquema rechaza** → el INSERT revienta
 *   en producción, con el tipo de daño descrito arriba. Es `gravedad: 'rompe'`.
 * - **El esquema acepta valores que el código no nombra** → la base guarda
 *   algo que ningún `switch` maneja. No rompe nada hoy; es `'sin_manejar'`.
 */

const IGNORADOS = new Set(['node_modules', 'dist', '.next', '.claude', '.git', 'coverage']);

/** Un conjunto de valores declarado en el esquema o en el código. */
export interface Declaracion {
  /** `messages.type` o `conversations.ts#MessageType`. */
  donde: string;
  valores: string[];
}

export interface Divergencia {
  columna: string;
  codigo: string;
  /** En el código y NO en el CHECK: la base los rechaza. */
  rechazados: string[];
  /** En el CHECK y NO en el código: nadie los maneja. */
  sinManejar: string[];
  gravedad: 'rompe' | 'sin_manejar';
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

/** Los literales de `('a', 'b', 'c')` o `['a', 'b']`. Devuelve `[]` si hay algo que no sea un literal. */
function literales(cuerpo: string): string[] {
  const piezas = cuerpo
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const valores: string[] = [];
  for (const pieza of piezas) {
    const m = /^'([^']*)'(?:::\s*[a-z_ ]+)?$/.exec(pieza) ?? /^"([^"]*)"$/.exec(pieza);
    if (!m) return [];
    valores.push(m[1]);
  }
  return valores;
}

/**
 * Los `CHECK (col IN (...))` vigentes.
 *
 * Las migraciones son acumulativas pero los `CHECK` no: se reemplazan con
 * `DROP CONSTRAINT` + `ADD CONSTRAINT`, que es justo lo que hubo que hacer para
 * arreglar el defecto que motivó esta guarda. Así que se recorren en orden y
 * **gana la última declaración** sobre cada `tabla.columna`; un `DROP` sin `ADD`
 * la saca de la lista.
 */
export function valoresQueAceptaElEsquema(raices: string[]): Declaracion[] {
  const vigentes = new Map<string, string[]>();
  // El orden de ejecución es el del número de migración, y los nombres llevan
  // ceros a la izquierda: ordenar por ruta es ordenar por versión.
  const sqls = raices.flatMap((r) => archivos(r, /\.sql$/)).sort((a, b) => a.localeCompare(b));

  for (const sql of sqls) {
    const texto = readFileSync(sql, 'utf8').replace(/--[^\n]*/g, '');

    // Dentro de un CREATE TABLE el CHECK no nombra la tabla.
    for (const tabla of texto.matchAll(
      /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\)[^;]*;/gi,
    )) {
      for (const chk of tabla[2].matchAll(/CHECK\s*\(\s*([a-z_][a-z0-9_]*)\s+IN\s*\(([^)]*)\)/gi)) {
        const valores = literales(chk[2]);
        if (valores.length) vigentes.set(`${tabla[1]}.${chk[1]}`, valores);
      }
    }

    for (const alter of texto.matchAll(
      /ALTER TABLE\s+(?:IF EXISTS\s+)?([a-z_][a-z0-9_]*)\s+([\s\S]*?);/gi,
    )) {
      const tabla = alter[1];
      for (const chk of alter[2].matchAll(
        /ADD CONSTRAINT\s+\S+\s+CHECK\s*\(\s*([a-z_][a-z0-9_]*)\s+IN\s*\(([^)]*)\)/gi,
      )) {
        const valores = literales(chk[2]);
        if (valores.length) vigentes.set(`${tabla}.${chk[1]}`, valores);
      }
      // Un DROP CONSTRAINT nombra la restricción, no la columna. El nombre que
      // usa Postgres por omisión —y el que usa este repo— es
      // `<tabla>_<columna>_check`, así que de ahí sale la columna.
      for (const drop of alter[2].matchAll(/DROP CONSTRAINT\s+(?:IF EXISTS\s+)?([a-z_0-9]+)/gi)) {
        const col = new RegExp(`^${tabla}_([a-z_0-9]+)_check$`).exec(drop[1])?.[1];
        if (col) vigentes.delete(`${tabla}.${col}`);
      }
    }
  }

  return [...vigentes.entries()]
    .map(([donde, valores]) => ({ donde, valores }))
    .sort((a, b) => a.donde.localeCompare(b.donde));
}

/**
 * Los conjuntos de literales declarados en el código.
 *
 * Dos formas, que son las dos con las que este repo declara un conjunto
 * cerrado: la unión de tipos (`type X = 'a' | 'b'`) y el array de literales
 * (`const X = ['a', 'b'] as const`). Se piden dos valores como mínimo: un
 * conjunto de uno no es un conjunto, es una constante.
 */
export function valoresQueDeclaraElCodigo(raices: string[]): Declaracion[] {
  const encontradas: Declaracion[] = [];

  for (const ruta of raices.flatMap((r) => archivos(r, /\.ts$/))) {
    if (/\.d\.ts$/.test(ruta)) continue;
    const codigo = readFileSync(ruta, 'utf8').replace(/\/\/[^\n]*/g, '');
    const corto = ruta.replace(/^.*?((?:packages|apps)\/)/, '$1');

    for (const m of codigo.matchAll(/\btype\s+([A-Za-z0-9_]+)\s*=\s*([^;{}]+);/g)) {
      const cuerpo = m[2].trim().replace(/^\|/, '');
      if (!/^(\s*'[^']*'\s*\|)+\s*'[^']*'\s*$/.test(cuerpo)) continue;
      const valores = cuerpo.split('|').map((p) => p.trim().slice(1, -1));
      if (valores.length >= 2) encontradas.push({ donde: `${corto}#${m[1]}`, valores });
    }

    for (const m of codigo.matchAll(
      /\bconst\s+([A-Za-z0-9_]+)\s*(?::[^=]+)?=\s*\[([^[\]]*)\]/g,
    )) {
      const valores = literales(m[2]);
      if (valores.length >= 2) encontradas.push({ donde: `${corto}#${m[1]}`, valores });
    }
  }

  return encontradas;
}

/**
 * El cruce.
 *
 * Para cada `CHECK`, la declaración del código que más valores comparte con él.
 * Se mira solo la mejor candidata: varias uniones se parecen entre sí —todos
 * los `status` de este repo tienen un `activo`— y reportar todas convertiría la
 * guarda en ruido, que es la forma más rápida de que una guarda se apague.
 */
/**
 * Cuánto se tienen que parecer dos listas para considerarlas la misma.
 *
 * Es `|∩| / |∪|`, y 0,6 sale de medirlo contra este repo. Sin este umbral la
 * guarda emparejaba `saved_filters.view` con la lista de las 58 tablas que
 * exporta una cuenta: comparten tres nombres y nada más. Cinco de las seis
 * primeras divergencias eran de esa clase.
 *
 * El precio está asumido: si dos copias de la misma lista se separaron tanto
 * que ya no se parecen, esta guarda no las ve. A cambio no inventa seis
 * problemas por cada uno real, que es lo que hace que una guarda se apague.
 */
const PARECIDO_MINIMO = 0.6;

export function esquemaVsCodigo(raicesSql: string[], raicesTs: string[]): Divergencia[] {
  const delCodigo = valoresQueDeclaraElCodigo(raicesTs);
  const divergencias: Divergencia[] = [];

  for (const check of valoresQueAceptaElEsquema(raicesSql)) {
    const enElCheck = new Set(check.valores);
    let mejor: { decl: Declaracion; parecido: number } | null = null;

    for (const decl of delCodigo) {
      const comunes = decl.valores.filter((v) => enElCheck.has(v)).length;
      if (comunes < 2) continue;
      const union = new Set([...decl.valores, ...check.valores]).size;
      const parecido = comunes / union;
      if (parecido < PARECIDO_MINIMO) continue;
      if (parecido > (mejor?.parecido ?? 0)) mejor = { decl, parecido };
    }
    if (!mejor) continue;

    const enElCodigo = new Set(mejor.decl.valores);
    const rechazados = mejor.decl.valores.filter((v) => !enElCheck.has(v));
    const sinManejar = check.valores.filter((v) => !enElCodigo.has(v));
    if (!rechazados.length && !sinManejar.length) continue;

    divergencias.push({
      columna: check.donde,
      codigo: mejor.decl.donde,
      rechazados,
      sinManejar,
      gravedad: rechazados.length ? 'rompe' : 'sin_manejar',
    });
  }

  return divergencias.sort(
    (a, b) =>
      Number(b.gravedad === 'rompe') - Number(a.gravedad === 'rompe') ||
      a.columna.localeCompare(b.columna),
  );
}

/** Una línea por divergencia, que es el formato de la lista base. */
export function comoLinea(d: Divergencia): string {
  const partes = [
    d.rechazados.length ? `el código produce ${d.rechazados.join(', ')} y la base los rechaza` : '',
    d.sinManejar.length ? `la base acepta ${d.sinManejar.join(', ')} y el código no los nombra` : '',
  ].filter(Boolean);
  return `${d.columna} ← ${d.codigo} — ${partes.join('; ')}`;
}
