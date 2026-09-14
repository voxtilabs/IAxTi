import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { splitIntoChunks, stripHtml } from '../domain/chunking';
import {
  addSource,
  deleteSource,
  expireSources,
  listSources,
  parseCatalog,
  processSource,
  tenantsWithExpirable,
} from '../application/sources';
import { getProduct, knowledgeContext, searchKnowledge } from '../application/search';
import type { EmbedPort } from '../application/embeddings';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

// Embedder falso pero SEMÁNTICO a su manera: bolsa de palabras a 768 dims
// por hash — textos que comparten palabras quedan cerca. Cuenta llamadas
// para probar el cache.
let llamadas = 0;
const fakeEmbed: EmbedPort = {
  async embed(texts) {
    llamadas += texts.length;
    return texts.map((t) => {
      const v = new Array(768).fill(0);
      for (const palabra of t.toLowerCase().split(/\W+/).filter((w) => w.length > 2)) {
        let h = 0;
        for (const ch of palabra) h = (h * 31 + ch.charCodeAt(0)) % 768;
        v[h] += 1;
      }
      const norma = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / norma);
    });
  },
};

const CSV = `nombre,precio,stock,descripcion
Manicure tradicional,12000,10,Manicure con esmalte tradicional
Manicure gel,18000,5,Esmaltado permanente en gel
Pedicure spa,22000,0,Pedicure completa con exfoliación`;

async function fuente(input: Parameters<typeof addSource>[1] extends infer T ? Omit<T, 'tenantId'> : never) {
  const s = await withTenant(admin, tenant, (c) =>
    addSource(c, { ...(input as object), tenantId: tenant } as Parameters<typeof addSource>[1]),
  );
  return withTenant(admin, tenant, (c) =>
    processSource(c, { tenantId: tenant, sourceId: s.id }, { embed: fakeEmbed }),
  );
}

function buscar(query: string) {
  return withTenant(admin, tenant, (c) => searchKnowledge(c, { tenantId: tenant, query }, fakeEmbed));
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('knowledge-test') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  for (const tabla of ['knowledge_query_cache', 'chunks', 'products', 'sources', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('dominio (#51)', () => {
  it('trocea con solape y limpia HTML sin dependencias', () => {
    const largo = Array.from({ length: 30 }, (_, i) => `Párrafo ${i} con bastante contenido de prueba para forzar el corte en pedazos.`).join('\n\n');
    const chunks = splitIntoChunks(largo);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(1300);
    expect(stripHtml('<p>Hola <b>mundo</b></p><script>alert(1)</script>')).toBe('Hola mundo');
  });

  it('el catálogo CSV sale con precio y stock como CAMPOS', () => {
    const filas = parseCatalog(CSV);
    expect(filas).toHaveLength(3);
    expect(filas[0]).toMatchObject({ name: 'Manicure tradicional', price: 12000, stock: 10 });
    expect(() => parseCatalog('a,b\n1,2')).toThrow(/nombre/);
  });
});

describe('fuentes e índice (#51)', () => {
  it('texto pegado queda activo, troceado y embebido (pgvector)', async () => {
    const s = await fuente({
      kind: 'texto',
      name: 'Políticas',
      content: 'Atendemos de martes a sábado de 10 a 19 horas. Las horas se agendan con anticipo del 30 por ciento.',
      actor: 'test',
    });
    expect(s.status).toBe('active');
    const chunks = await admin.query('SELECT count(*)::int AS n FROM chunks WHERE tenant_id = $1', [tenant]);
    expect(chunks.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('el catálogo llena products y también el índice semántico', async () => {
    const s = await fuente({ kind: 'catalogo', name: 'Catálogo sept.', content: CSV, actor: 'test' });
    expect(s.status).toBe('active');
    const productos = await withTenant(admin, tenant, (c) => getProduct(c, tenant, 'manicure'));
    expect(productos.length).toBe(2);
    expect(productos.find((p) => p.name === 'Manicure gel')).toMatchObject({ price: 18000, stock: 5, sourceName: 'Catálogo sept.' });
  });

  it('la búsqueda encuentra lo correcto CON cita, y el cache evita re-embeber', async () => {
    const res = await buscar('sábado horas atención');
    expect(res.cached).toBe(false);
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0].sourceName).toBe('Políticas');
    expect(res.hits[0].content).toContain('martes a sábado');

    const antes = llamadas;
    const denuevo = await buscar('Sábado HORAS atención'); // mayúsculas y acentos: mismo hash
    expect(denuevo.cached).toBe(true);
    expect(llamadas).toBe(antes); // ni un embedding nuevo
    expect(knowledgeContext(denuevo)).toContain('según');
    expect(knowledgeContext(denuevo)).toContain('[Políticas]');
  });

  it('FAQ por pregunta, y la vigencia vencida ignora y AVISA', async () => {
    await fuente({
      kind: 'faq',
      name: 'FAQ',
      content: JSON.stringify([{ q: '¿Aceptan tarjeta?', a: 'Sí, débito y crédito sin recargo.' }]),
      actor: 'test',
    });
    const s = await fuente({
      kind: 'texto',
      name: 'Promo agosto',
      content: 'Promoción especial: manicure gel a mitad de precio durante agosto.',
      validUntil: new Date(Date.now() - 60_000),
      actor: 'test',
    });
    expect(s.status).toBe('active'); // recién indexada

    expect(await withTenant(admin, tenant, (c) => tenantsWithExpirable(c))).toContain(tenant);
    const vencidas = await withTenant(admin, tenant, (c) => expireSources(c, tenant));
    expect(vencidas).toBe(1);
    const evento = await admin.query(
      `SELECT payload FROM outbox WHERE name = 'knowledge.source_expired' AND tenant_id = $1`,
      [tenant],
    );
    expect(evento.rows[0].payload.name).toBe('Promo agosto');

    // La búsqueda ya no la usa y lo dice.
    const res = await buscar('¿tienen promoción de manicure gel?');
    expect(res.hits.every((h) => h.sourceName !== 'Promo agosto')).toBe(true);
    expect(res.expiredSources).toContain('Promo agosto');
    expect(knowledgeContext(res)).toContain('VENCIDAS');
  });

  it('reindexar tras cambiar la fuente reemplaza los chunks y limpia el cache', async () => {
    const fuentes = await withTenant(admin, tenant, (c) => listSources(c, tenant));
    const politicas = fuentes.find((f) => f.name === 'Políticas')!;
    await admin.query('UPDATE sources SET content = $2 WHERE id = $1', [
      politicas.id,
      'Ahora atendemos TODOS los días de 9 a 21 horas.',
    ]);
    await withTenant(admin, tenant, (c) =>
      processSource(c, { tenantId: tenant, sourceId: politicas.id }, { embed: fakeEmbed }),
    );
    const res = await buscar('sábado horas atención'); // cache invalidado
    expect(res.cached).toBe(false);
    expect(res.hits[0].content).toContain('TODOS los días');
  });

  it('otro tenant no ve NADA (RLS + tenant en cada query)', async () => {
    const t2 = await admin.query("INSERT INTO tenants (name) VALUES ('knowledge-otro') RETURNING id");
    const ajeno = await withTenant(admin, t2.rows[0].id, (c) =>
      searchKnowledge(c, { tenantId: t2.rows[0].id, query: 'manicure' }, fakeEmbed),
    );
    expect(ajeno.hits).toHaveLength(0);
    await admin.query('DELETE FROM knowledge_query_cache WHERE tenant_id = $1', [t2.rows[0].id]);
  });

  it('eliminar la fuente arrasa con chunks y productos (cascade)', async () => {
    const fuentes = await withTenant(admin, tenant, (c) => listSources(c, tenant));
    const catalogo = fuentes.find((f) => f.kind === 'catalogo')!;
    await withTenant(admin, tenant, (c) =>
      deleteSource(c, { tenantId: tenant, sourceId: catalogo.id, actor: 'test' }),
    );
    const productos = await admin.query('SELECT count(*)::int AS n FROM products WHERE tenant_id = $1', [tenant]);
    expect(productos.rows[0].n).toBe(0);
  });
});
