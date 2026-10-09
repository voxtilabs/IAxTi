import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { addSource, listSources } from '../application/sources';
import { fuentesCitadas, searchKnowledge } from '../application/search';
import type { EmbedPort } from '../application/embeddings';
import { DIMENSIONES } from '../application/embeddings';

/**
 * De dónde sacó la IA lo que dijo (#714).
 *
 * Tres cosas que el conocimiento sabía y no decía:
 *
 *  1. **En qué fuente se apoyó una respuesta.** Las citas se armaban, viajaban
 *     al modelo y se quedaban ahí.
 *  2. **Qué fuentes no se usan nunca.** Un negocio sube ocho documentos, la IA
 *     se apoya en dos, y los otros seis siguen costando indexación y contexto
 *     sin que nadie lo sepa.
 *  3. **Los `[[enlaces]]` de los markdown importados.** Se extraían, se
 *     devolvían en la respuesta HTTP y nadie los guardaba.
 *
 * Lo que estas pruebas cuidan sobre todo es que el uso se marque donde se marca
 * UNA vez: dentro de `searchKnowledge`. Si cada llamador tuviera que acordarse,
 * lo que la IA consulta por herramienta no contaría y la pantalla diría que esa
 * fuente no sirve.
 */
let pool: Pool;
let tenant: string;

/** Un embedder de mentira y DETERMINISTA: nada de red en una prueba. */
const embedFalso: EmbedPort = {
  async embed(textos) {
    return textos.map(() => Array.from({ length: DIMENSIONES }, (_, i) => (i === 0 ? 1 : 0)));
  },
};

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants(name) VALUES ('Fuentes #714') RETURNING id")).rows[0]
    .id;
});
afterAll(async () => pool.end());

/** Una fuente activa con un pasaje indexado y su vector. */
async function fuenteConPasaje(nombre: string, texto: string): Promise<string> {
  const fuente = await withTenant(pool, tenant, (c) =>
    addSource(c, { tenantId: tenant, kind: 'texto', name: nombre, content: texto }),
  );
  const [vector] = await embedFalso.embed([texto], 'pasaje');
  await pool.query(
    `INSERT INTO chunks (tenant_id, source_id, content, embedding)
     VALUES ($1, $2, $3, $4::halfvec)`,
    [tenant, fuente.id, texto, `[${vector.join(',')}]`],
  );
  await pool.query("UPDATE sources SET status = 'active' WHERE id = $1", [fuente.id]);
  return fuente.id;
}

describe('el uso de cada fuente (#714)', () => {
  it('una fuente recién subida no se ha usado nunca, y se dice', async () => {
    await fuenteConPasaje('Políticas', 'El despacho a regiones demora 3 días.');
    const [fuente] = await withTenant(pool, tenant, (c) => listSources(c, tenant));
    // `null` y no una fecha falsa: «nunca» es un dato, y la fecha de creación
    // en su lugar diría que se usó el día que se subió.
    expect(fuente.lastUsedAt).toBeNull();
    expect(fuente.useCount).toBe(0);
  });

  it('consultar el conocimiento marca la fuente que respaldó la respuesta', async () => {
    const id = await fuenteConPasaje('Lista de precios', 'La manicure cuesta 15.000 pesos.');
    const res = await withTenant(pool, tenant, (c) =>
      searchKnowledge(c, { tenantId: tenant, query: '¿cuánto cuesta la manicure?' }, embedFalso),
    );
    expect(res.hits.length).toBeGreaterThan(0);

    const marcada = (await pool.query('SELECT last_used_at, use_count FROM sources WHERE id = $1', [id]))
      .rows[0];
    expect(marcada.last_used_at).not.toBeNull();
    expect(Number(marcada.use_count)).toBeGreaterThan(0);
  });

  it('la respuesta que sale del cache TAMBIÉN cuenta como uso', async () => {
    const id = await fuenteConPasaje('Horarios', 'Atendemos de lunes a viernes de 9 a 19.');
    const pregunta = `¿a qué hora abren? ${id}`;
    const uso = async (): Promise<number> =>
      Number(
        (await pool.query('SELECT use_count FROM sources WHERE id = $1', [id])).rows[0].use_count,
      );

    await withTenant(pool, tenant, (c) =>
      searchKnowledge(c, { tenantId: tenant, query: pregunta }, embedFalso),
    );
    const primera = await uso();
    const segunda = await withTenant(pool, tenant, (c) =>
      searchKnowledge(c, { tenantId: tenant, query: pregunta }, embedFalso),
    );
    // Que de verdad vino del cache: si no, esta prueba estaría midiendo otra
    // cosa y pasaría igual.
    expect(segunda.cached).toBe(true);
    // Y aun así contó. Las preguntas más repetidas del negocio son las que más
    // se cachean: no contarlas haría que justo esas fuentes se vieran sin uso.
    expect(await uso()).toBeGreaterThan(primera);
  });

  it('las fuentes citadas vienen con su nombre y sin repetir', async () => {
    const res = {
      hits: [
        { content: 'a', question: null, sourceId: 'f1', sourceName: 'Precios', score: 0.9 },
        { content: 'b', question: null, sourceId: 'f1', sourceName: 'Precios', score: 0.8 },
        { content: 'c', question: null, sourceId: 'f2', sourceName: 'Horarios', score: 0.7 },
      ],
      cached: false,
      expiredSources: [],
    };
    // Dos pasajes de la misma fuente son UNA cita: «según Precios, Precios»
    // no dice nada más que «según Precios».
    expect(fuentesCitadas(res)).toEqual([
      { id: 'f1', nombre: 'Precios' },
      { id: 'f2', nombre: 'Horarios' },
    ]);
  });

  it('sin pasajes, citadas es una lista VACÍA y no indefinida', () => {
    // La distinción que sostiene toda la pantalla: `[]` es «lo dijo sin
    // apoyarse en nada» y se puede afirmar. No saber es otra cosa, y la decide
    // quien llama, no esto.
    expect(fuentesCitadas({ hits: [], cached: false, expiredSources: [] })).toEqual([]);
  });
});

describe('los enlaces entre fuentes (#714)', () => {
  it('se guardan al crear la fuente y se resuelven cuando el destino existe', async () => {
    await withTenant(pool, tenant, (c) =>
      addSource(c, { tenantId: tenant, kind: 'texto', name: 'Despacho', content: 'A todo Chile.' }),
    );
    const conEnlaces = await withTenant(pool, tenant, (c) =>
      addSource(c, {
        tenantId: tenant,
        kind: 'texto',
        name: 'Venta',
        content: 'Ver [[Despacho]] y [[Garantía]].',
        enlaces: ['Despacho', 'Garantía'],
      }),
    );

    const fuentes = await withTenant(pool, tenant, (c) => listSources(c, tenant));
    const venta = fuentes.find((f) => f.id === conEnlaces.id)!;
    const despacho = fuentes.find((f) => f.name === 'Despacho')!;

    // El que existe apunta a su fuente; el que no, se muestra igual con null.
    // Un enlace suelto no es un error: dice que falta un documento.
    expect(venta.enlaces).toEqual([
      { nombre: 'Despacho', sourceId: despacho.id },
      { nombre: 'Garantía', sourceId: null },
    ]);
  });

  it('una fuente sin enlaces trae la lista vacía, no indefinida', async () => {
    const sola = await withTenant(pool, tenant, (c) =>
      addSource(c, { tenantId: tenant, kind: 'texto', name: 'Suelta', content: 'Nada que enlazar.' }),
    );
    const fuentes = await withTenant(pool, tenant, (c) => listSources(c, tenant));
    expect(fuentes.find((f) => f.id === sola.id)!.enlaces).toEqual([]);
  });
});
