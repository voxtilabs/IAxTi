import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { columnasDeclaradas, columnasSinLector, lecturasPorTabla } from '../src/columnas-sin-lector';

/**
 * Una columna nueva sin lector no entra en silencio (#703).
 *
 * Medido el 08/10 cruzando las migraciones contra todo el código: **28 columnas
 * se escribían y ningún `SELECT` las devolvía**. De ahí salieron ocho issues
 * —#695 a #702— y ésta es la guarda para que la número 29 avise sola.
 *
 * El patrón: **declarado en un lado, aplicado en ninguno**. Una columna sin
 * lector no rompe nada, no sale en ninguna prueba y no aparece en ningún log.
 * Simplemente la función no existe, y el esquema da la impresión contraria: a
 * quien lo lee le parece que eso ya está hecho. Y se acumula sola —
 * `agent_executions.tools_called` estuvo guardando `[]` en cada corrida desde
 * `0001_agents.sql`.
 *
 * La lista base lleva un MOTIVO por línea, al revés que la de exports (#664),
 * que no los pide. Acá sí: son veintitantas entradas, no doscientas, y en una
 * lista de ese tamaño el porqué es lo que impide que crezca sola.
 */
const RAIZ = join(__dirname, '..', '..', '..');
const MIGRACIONES = [join(RAIZ, 'packages', 'modules')];
const FUENTES = [join(RAIZ, 'packages'), join(RAIZ, 'apps')];
const LISTA = join(RAIZ, 'docs', 'columnas-sin-lector.txt');

/** `tabla.columna — motivo` por línea. */
const base = readFileSync(LISTA, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'))
  .map((l) => {
    const [columna, ...resto] = l.split(' — ');
    return { columna: columna.trim(), motivo: resto.join(' — ').trim() };
  });

const COLUMNAS = [
  { tabla: 'campaigns', columna: 'created_by' },
  { tabla: 'segments', columna: 'created_by' },
  { tabla: 'deals', columna: 'won_at' },
  { tabla: 'conversations', columna: 'unattended_alerted_at' },
];
const leidas = (...textos: string[]) => lecturasPorTabla(COLUMNAS, textos);

describe('el escáner distingue leer de escribir (#703)', () => {
  it('un INSERT no es un lector: es justo lo que ya existía', () => {
    expect(
      leidas("`INSERT INTO campaigns (tenant_id, name, created_by) VALUES ($1,$2,$3)`"),
    ).not.toContain('campaigns.created_by');
  });

  it('el SET de un UPDATE tampoco, ni con la columna a la derecha', () => {
    // `won_at = CASE WHEN ... THEN now() ELSE won_at END` la nombra dos veces y
    // no la lee nadie: ése era exactamente el estado de #695.
    expect(
      leidas("`UPDATE deals SET won_at = CASE WHEN $4 = 'won' THEN now() ELSE won_at END`"),
    ).not.toContain('deals.won_at');
  });

  it('un RETURNING * no es un lector: que la fila vuelva no es que alguien la mire', () => {
    expect(leidas("`UPDATE deals SET status = $2 WHERE id = $1 RETURNING *`"))
      .not.toContain('deals.won_at');
  });

  it('el WHERE de un UPDATE SÍ: así se consigue avisar una sola vez', () => {
    // El aprendizaje de #698. La medición original contó `SELECT` y dio estas
    // columnas por no leídas; el lector era el WHERE, y es el que hace que el
    // aviso de una conversación sin atender salga UNA vez y no en cada pasada.
    expect(
      leidas(
        "`UPDATE conversations SET unattended_alerted_at = $3 WHERE unattended_alerted_at IS NULL`",
      ),
    ).toContain('conversations.unattended_alerted_at');
  });

  it('proyectarla en un SELECT, obviamente', () => {
    expect(leidas("'SELECT id, created_by FROM segments WHERE tenant_id = $1'"))
      .toContain('segments.created_by');
  });

  it('tomarla de la fila de un SELECT *, también', () => {
    expect(leidas("const q = 'SELECT * FROM segments'; const a = row.created_by;"))
      .toContain('segments.created_by');
  });

  it('y nombrarla en camelCase, que es como la lleva un DTO', () => {
    expect(leidas("const q = 'SELECT * FROM segments'; interface S { createdBy: Quien }"))
      .toContain('segments.created_by');
  });

  it('la TABLA importa: dos created_by no se cubren entre ellos', () => {
    // Ésta es la trampa que haría inútil a una guarda que solo mire el nombre
    // de la columna: con un solo lector se pondrían verdes las dos.
    const una = leidas("'SELECT id, created_by FROM campaigns WHERE tenant_id = $1'");
    expect(una).toContain('campaigns.created_by');
    expect(una).not.toContain('segments.created_by');
  });

  it('un comentario que la nombra NO cuenta como lector', () => {
    // Los comentarios de este repo nombran columnas todo el tiempo —explican
    // por qué algo no se usa, justamente— y ya pusieron en verde a cuatro
    // guardas distintas.
    expect(
      leidas(
        '// `created_by` de campaigns se escribe y nadie lo lee',
        '/* row.created_by de segments */',
        "const q = 'SELECT 1 FROM segments'; // createdBy",
      ),
    ).toEqual(new Set());
  });
});

describe('la lista base de columnas sin lector (#703)', () => {
  it('el escáner encuentra el esquema (si esto falla, se rompió el escáner)', () => {
    const todas = columnasDeclaradas(MIGRACIONES).map((c) => `${c.tabla}.${c.columna}`);
    expect(todas.length).toBeGreaterThan(400);
    expect(todas).toContain('deals.won_at');
    expect(todas).toContain('conversations.last_inbound_at');
    // Y no confunde una restricción de tabla con una columna.
    expect(todas.filter((c) => /\.(primary|unique|constraint|check|foreign)$/.test(c))).toEqual([]);
  });

  it('`updated_at` queda fuera por regla, y es la única regla', () => {
    // Diecisiete entradas diciendo lo mismo enseñarían a no mirar la lista.
    // `created_at` NO queda fuera: «desde cuándo existe esto» sí se muestra.
    const sin = columnasSinLector(MIGRACIONES, FUENTES);
    expect(sin.filter((c) => c.endsWith('.updated_at'))).toEqual([]);
    expect(sin.some((c) => c.endsWith('.created_at')), 'created_at se sigue midiendo').toBe(true);
  });

  it('la lista está ordenada y sin repetidas: si no, el diff no se lee', () => {
    const columnas = base.map((e) => e.columna);
    expect(columnas).toEqual([...columnas].sort());
    expect(new Set(columnas).size).toBe(columnas.length);
  });

  it('cada entrada explica POR QUÉ, no solo que falta', () => {
    // Es el punto del criterio 2 del issue: tener que escribir el porqué es lo
    // que impide que la lista crezca sola. Un motivo que dice «#700» está bien
    // —apunta al trabajo—; uno vacío no.
    const sinMotivo = base.filter((e) => e.motivo.length < 4 || e.motivo.startsWith('SIN MOTIVO'));
    expect(
      sinMotivo.map((e) => e.columna),
      'Escribe por qué esta columna no se lee, o dale un lector:\n  ' +
        sinMotivo.map((e) => e.columna).join('\n  '),
    ).toEqual([]);
  });

  it('no aparece ninguna columna nueva sin lector', () => {
    const ahora = columnasSinLector(MIGRACIONES, FUENTES);
    const nuevas = ahora.filter((c) => !base.some((e) => e.columna === c));
    expect(
      nuevas,
      'Estas columnas se escriben y ningún SELECT las devuelve. Proyéctalas en la ' +
        'consulta que alimenta la pantalla donde se usan, o agrégalas a ' +
        'docs/columnas-sin-lector.txt CON SU MOTIVO:\n  ' + nuevas.join('\n  '),
    ).toEqual([]);
  });

  it('y si alguna consiguió lector, la marca BAJA', () => {
    const ahora = columnasSinLector(MIGRACIONES, FUENTES);
    const resueltas = base.filter((e) => !ahora.includes(e.columna)).map((e) => e.columna);
    expect(
      resueltas,
      'Estas ya tienen lector: la marca tiene que bajar. Corre\n' +
        '  node scripts/columnas-sin-lector.mjs --escribir\n' +
        'Sin esto el trinquete se afloja solo, y una deuda que no se ve bajar ' +
        'nunca baja:\n  ' + resueltas.join('\n  '),
    ).toEqual([]);
  });
});
