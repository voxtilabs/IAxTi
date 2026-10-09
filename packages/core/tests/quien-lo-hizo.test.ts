import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { columnasDeAutor, columnasDeAutorSinLector, lecturasPorTabla } from '../src/columnas-de-autor';

/**
 * Las columnas que guardan QUIÉN, con trinquete (#697).
 *
 * Medido el 08/10: nueve columnas `*_by` / `*_por` se escribían en cada acción y
 * **ninguna pantalla las mostraba**. Quién apagó la IA, quién lanzó la campaña a
 * 650 personas, quién aprobó lo que propuso el agente, a quién se le quitó la
 * conversación.
 *
 * El patrón —escrito en un lado, leído en ninguno— se repite solo porque la
 * columna no avisa: el `INSERT` compila, la migración pasa, y que falte el
 * lector no rompe nada. Ya pasó con `won_at` (#695), con `company_id` (#460) y
 * con el consentimiento (#696). Esta guarda es para que la próxima avise sola.
 *
 * Exige cero, al revés que la guarda de exports (#664): acá la deuda son nueve
 * entradas y quedó en cero en este PR, así que cualquier columna nueva sin
 * lector es deuda nueva — no herencia. Si una de verdad no debe mostrarse, el
 * lugar de decirlo es un comentario junto a la columna y un motivo en el PR, no
 * una lista que junta polvo.
 */
const RAIZ = join(__dirname, '..', '..', '..');
const MIGRACIONES = [join(RAIZ, 'packages', 'modules')];
const FUENTES = [join(RAIZ, 'packages'), join(RAIZ, 'apps')];

const COLUMNAS = [
  { tabla: 'campaigns', columna: 'created_by' },
  { tabla: 'segments', columna: 'created_by' },
  { tabla: 'deals', columna: 'won_by' },
  { tabla: 'agent_proposals', columna: 'applied_by' },
  { tabla: 'sequence_enrollments', columna: 'enrolled_by' },
];
const leidas = (...textos: string[]) => lecturasPorTabla(COLUMNAS, textos);

describe('el escáner distingue leer de escribir', () => {
  it('un INSERT no es un lector: es justo lo que ya existía', () => {
    expect(
      leidas(
        "await client.query(`INSERT INTO campaigns (tenant_id, name, created_by) VALUES ($1,$2,$3)`, [t, n, u]);",
      ),
    ).not.toContain('campaigns.created_by');
  });

  it('un RETURNING * tampoco: que la fila vuelva no es que alguien la mire', () => {
    // Éste es el caso exacto de `won_at` (#695): el UPDATE la devolvía y el
    // mapeador no la tocaba, así que nadie la veía nunca.
    expect(
      leidas("await client.query(`UPDATE deals SET won_by = $2 WHERE id = $1 RETURNING *`, [id, u]);"),
    ).not.toContain('deals.won_by');
  });

  it('proyectarla en un SELECT sí', () => {
    expect(
      leidas("await client.query('SELECT id, created_by FROM segments WHERE tenant_id = $1', [t]);"),
    ).toContain('segments.created_by');
  });

  it('tomarla de la fila de un SELECT * también', () => {
    expect(
      leidas("const p = await client.query('SELECT * FROM agent_proposals'); quienFue(q, p.rows[0].applied_by);"),
    ).toContain('agent_proposals.applied_by');
  });

  it('y nombrarla en camelCase, que es como la lleva un DTO', () => {
    expect(
      leidas("interface E { enrolledBy: Quien }\nconst q = 'SELECT * FROM sequence_enrollments';"),
    ).toContain('sequence_enrollments.enrolled_by');
  });

  it('la TABLA importa: tres created_by distintos no se cubren entre ellos', () => {
    // Ésta es la trampa que hace inútil a una guarda que solo mire el nombre de
    // la columna: con un solo lector se pondrían verdes las tres.
    const unaSola = leidas(
      "await client.query('SELECT id, created_by FROM campaigns WHERE tenant_id = $1', [t]);",
    );
    expect(unaSola).toContain('campaigns.created_by');
    expect(unaSola).not.toContain('segments.created_by');
  });

  it('un comentario que la nombra NO cuenta como lector', () => {
    // Los comentarios de este repo nombran columnas todo el tiempo —explican
    // por qué algo no se usa, justamente— y ya pusieron en verde a cuatro
    // guardas distintas.
    expect(leidas('// `created_by` de campaigns se escribe y nadie lo lee', '/* row.applied_by de agent_proposals */'))
      .toEqual(new Set());
  });
});

describe('las columnas de autor del repo (#697)', () => {
  it('el escáner encuentra algo (si esto falla, se rompió el escáner)', () => {
    const todas = columnasDeAutor(MIGRACIONES).map((c) => `${c.tabla}.${c.columna}`);
    expect(todas.length).toBeGreaterThanOrEqual(8);
    // Tres que existen desde antes de esta guarda: si alguna desaparece de la
    // lista, el parseo del SQL se rompió y la guarda pasó a medir nada.
    expect(todas).toContain('campaigns.created_by');
    expect(todas).toContain('agente_general_apagado.apagado_por');
    expect(todas).toContain('invitations.accepted_by');
    expect(todas).toEqual([...todas].sort());
  });

  it('toda columna que guarda quién hizo algo tiene quién la lea', () => {
    const sinLector = columnasDeAutorSinLector(MIGRACIONES, FUENTES);
    expect(
      sinLector,
      'Estas columnas guardan QUIÉN hizo algo y nadie las lee. Proyéctalas en la ' +
        'consulta que alimenta la pantalla donde se ve la acción y resuélvelas con ' +
        '`quienesSon` de identity (un nombre, no un UUID). Si de verdad no debe ' +
        'mostrarse, dilo en un comentario junto a la columna y explica por qué en el PR:\n  ' +
        sinLector.join('\n  '),
    ).toEqual([]);
  });
});
