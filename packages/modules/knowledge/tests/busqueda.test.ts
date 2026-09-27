import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { addSource, processSource } from '../application/sources';
import { knowledgeContext, searchKnowledge } from '../application/search';
import { DIMENSIONES } from '../application/embeddings';
import type { EmbedPort } from '../application/embeddings';
import { toVectorLiteral } from '../domain/chunking';

// Lo que la IA le contesta a un cliente sale de acá, y la regla más dura del
// producto es que no invente precio, stock ni plazo. Un pasaje que no llega y
// un pasaje vencido que sí llega rompen la misma regla: el asistente afirma
// algo falso con total seguridad. Estas dos pruebas cubren esos dos caminos.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
const tenants: string[] = [];

async function nuevoTenant(nombre: string): Promise<string> {
  const r = await admin.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [nombre]);
  tenants.push(r.rows[0].id);
  return r.rows[0].id;
}

/** Vector unitario determinista: la misma semilla, el mismo vector. */
function vector(semilla: number): number[] {
  const v = new Array(DIMENSIONES).fill(0);
  let x = semilla;
  for (let i = 0; i < DIMENSIONES; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    v[i] = x / 2147483648 - 0.5;
  }
  return unitario(v);
}

function unitario(v: number[]): number[] {
  const norma = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norma);
}

/** `v` corrido un poco hacia otra dirección: queda cerca, pero no encima. */
function cerca(v: number[], cuanto: number, semilla: number): number[] {
  const r = vector(semilla);
  return unitario(v.map((x, i) => x + cuanto * r[i]));
}

const PREGUNTA = vector(7);

/** Devuelve siempre el mismo vector: la pregunta de la prueba. */
const puertoFijo: EmbedPort = { async embed(texts) { return texts.map(() => PREGUNTA); } };

/** Bolsa de palabras por hash: textos que comparten palabras quedan cerca. */
let llamadas = 0;
const puertoPorPalabras: EmbedPort = {
  async embed(texts) {
    llamadas += texts.length;
    return texts.map((t) => {
      const v = new Array(DIMENSIONES).fill(0);
      for (const palabra of t.toLowerCase().split(/\W+/).filter((w) => w.length > 2)) {
        let h = 0;
        for (const ch of palabra) h = (h * 31 + ch.charCodeAt(0)) % DIMENSIONES;
        v[h] += 1;
      }
      return unitario(v);
    });
  },
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
});

afterAll(async () => {
  for (const t of tenants) {
    for (const tabla of ['knowledge_query_cache', 'chunks', 'products', 'sources', 'outbox']) {
      await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [t]);
    }
  }
  await admin.end();
});

describe('el índice HNSW filtra DESPUÉS de escanear (#51)', () => {
  it('el negocio chico recibe SUS pasajes aunque los vecinos sean de otro negocio', async () => {
    // El escaneo del índice entrega los vecinos más cercanos de TODA la tabla
    // y el `WHERE tenant_id` se aplica después. Acá el negocio grande tiene
    // 120 pasajes pegados a la pregunta —más que el `hnsw.ef_search` de 40— y
    // el chico uno solo, más lejos: los candidatos que devuelve el índice son
    // todos del grande, el filtro los bota y el chico se queda sin nada.
    //
    // Los dos `SET LOCAL` no son trampa: son la única forma de reproducir en
    // una tabla de prueba el plan que en producción el planificador elige solo
    // cuando la tabla crece (`Index Scan using chunks_embedding_idx` con
    // `Filter: tenant_id = ...`). Sin ellos, con 121 filas Postgres prefiere
    // el barrido secuencial, que sí es exacto, y el defecto no se ve.
    const grande = await nuevoTenant('busqueda-grande');
    const chico = await nuevoTenant('busqueda-chico');
    const fuenteGrande = await withTenant(admin, grande, (c) =>
      addSource(c, { tenantId: grande, kind: 'texto', name: 'Manual del grande', content: 'x', actor: 'test' }),
    );
    const fuenteChica = await withTenant(admin, chico, (c) =>
      addSource(c, { tenantId: chico, kind: 'texto', name: 'Precios del chico', content: 'x', actor: 'test' }),
    );
    for (const id of [fuenteGrande.id, fuenteChica.id]) {
      await admin.query("UPDATE sources SET status = 'active' WHERE id = $1", [id]);
    }
    for (let i = 0; i < 120; i++) {
      await admin.query(
        `INSERT INTO chunks (tenant_id, source_id, content, embedding, position)
         VALUES ($1, $2, $3, $4::halfvec, $5)`,
        [grande, fuenteGrande.id, `Pasaje ajeno ${i}`, toVectorLiteral(cerca(PREGUNTA, 0.05, 1000 + i)), i],
      );
    }
    await admin.query(
      `INSERT INTO chunks (tenant_id, source_id, content, embedding, position)
       VALUES ($1, $2, $3, $4::halfvec, 0)`,
      [chico, fuenteChica.id, 'El manicure sale 12.000 pesos.', toVectorLiteral(cerca(PREGUNTA, 0.6, 99))],
    );

    const res = await withTenant(admin, chico, async (c) => {
      await c.query('SET LOCAL enable_seqscan = off');
      await c.query('SET LOCAL enable_sort = off');
      return searchKnowledge(c, { tenantId: chico, query: 'cuanto sale el manicure' }, puertoFijo);
    });

    expect(res.hits.map((h) => h.content)).toContain('El manicure sale 12.000 pesos.');
    expect(res.hits.every((h) => h.sourceName === 'Precios del chico')).toBe(true);
  });
});

describe('el cache no puede citar como vigente una fuente que venció (#51)', () => {
  it('la lista de precios que venció hace media hora sale del cache y se avisa', async () => {
    // `expireSources` es quien pone 'expired' y avisa, pero corre cada tanto.
    // En la ventana entre que el reloj pasa `valid_until` y que el barrido
    // llega, el cache de una hora seguía entregando los pasajes ya elegidos
    // —la lista de precios vieja— y encima sin el aviso de fuente vencida,
    // porque el aviso miraba solo el `status`. La IA citaba un precio muerto
    // con total seguridad.
    const tenant = await nuevoTenant('busqueda-vigencia');
    const indexar = async (
      nombre: string,
      contenido: string,
      validUntil: Date | null = null,
    ) => {
      const f = await withTenant(admin, tenant, (c) =>
        addSource(c, { tenantId: tenant, kind: 'texto', name: nombre, content: contenido, validUntil, actor: 'test' }),
      );
      await withTenant(admin, tenant, (c) =>
        processSource(c, { tenantId: tenant, sourceId: f.id }, { embed: puertoPorPalabras }),
      );
      return f.id;
    };
    const buscar = () =>
      withTenant(admin, tenant, (c) =>
        searchKnowledge(c, { tenantId: tenant, query: 'cuanto sale el manicure gel' }, puertoPorPalabras),
      );

    const precios = await indexar(
      'Lista de precios de agosto',
      'El manicure gel sale 18.000 pesos y el tradicional 12.000 pesos.',
      new Date(Date.now() + 60_000),
    );
    await indexar('Horarios', 'Atendemos de martes a sabado de 10 a 19 horas.');

    const primera = await buscar();
    expect(primera.cached).toBe(false);
    expect(primera.hits.some((h) => h.sourceId === precios)).toBe(true);

    // Pasa el reloj y NO el barrido: la fuente sigue 'active' en la base.
    await admin.query(
      `UPDATE sources SET valid_until = now() - interval '30 minutes' WHERE id = $1`,
      [precios],
    );
    const estado = await admin.query('SELECT status FROM sources WHERE id = $1', [precios]);
    expect(estado.rows[0].status, 'el barrido no corrió, a propósito').toBe('active');

    const antes = llamadas;
    const segunda = await buscar();
    expect(segunda.hits.some((h) => h.sourceId === precios), 'ni un pasaje de la vencida').toBe(false);
    expect(segunda.cached, 'el cache rancio se descarta y se vuelve a buscar').toBe(false);
    expect(llamadas, 'y eso cuesta un embedding: es el precio de no mentir').toBeGreaterThan(antes);
    expect(segunda.expiredSources).toContain('Lista de precios de agosto');
    expect(knowledgeContext(segunda)).toContain('VENCIDAS');
    // El conocimiento que sí está vigente sigue llegando.
    expect(segunda.hits.length).toBeGreaterThan(0);
  });
});
