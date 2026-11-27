import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import type { EmbedPort } from '../application/embeddings';
import { DIMENSIONES } from '../application/embeddings';
import { toVectorLiteral } from '../domain/chunking';
import { searchKnowledge } from '../application/search';
import { listSources } from '../application/sources';
import {
  aprobarFuenteAprendida,
  crearFuenteAprendida,
  descartarEntradaAprendida,
  editarEntradaAprendida,
  leerFuenteAprendida,
  TITULO_DE_LO_APRENDIDO,
} from '../application/aprendidas';

/**
 * La fuente «por revisar» de lo aprendido de los chats (#1406, ADR-0039).
 *
 * Lo que estas pruebas sostienen son las dos reglas del ADR que la base
 * tiene que hacer cumplir solas:
 *
 * - la búsqueda del asistente NO la ve hasta que se aprueba (regla 3);
 * - aprobarla la deja `active` por el camino de siempre, con sus chunks.
 *
 * Y las dos que sostiene el módulo: editar y descartar dejan auditoría, y un
 * negocio no ve la fuente aprendida de otro.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenantA: string;
let tenantB: string;

const embedFalso: EmbedPort = {
  async embed(textos) {
    return textos.map(() => Array.from({ length: DIMENSIONES }, (_, i) => (i === 0 ? 1 : 0)));
  },
};

const ENTRADAS = [
  {
    pregunta: '¿Hacen despacho?',
    respuesta: 'Sí, a todo Chile en 3 a 5 días.',
    tipo: 'despacho' as const,
    fecha: '2026-11-20',
  },
  {
    pregunta: '¿Cuánto vale la manicure?',
    respuesta: '$15.000.',
    tipo: 'precio' as const,
    fecha: '2026-11-18',
    aviso: 'Precio visto en un chat del 18-11; confírmalo antes de aprobar.',
  },
];

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const crear = async (nombre: string) =>
    (await admin.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [nombre])).rows[0].id;
  tenantA = await crear('aprender-1406-a');
  tenantB = await crear('aprender-1406-b');
});

afterAll(async () => {
  for (const t of [tenantA, tenantB]) {
    for (const tabla of ['knowledge_query_cache', 'chunks', 'products', 'sources', 'audit_log', 'outbox']) {
      await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [t]).catch(() => undefined);
    }
  }
  await admin.end();
});

describe('crearFuenteAprendida', () => {
  it('nace por revisar, con el título del ADR y las entradas y el tono en el contenido', async () => {
    const source = await withTenant(admin, tenantA, (c) =>
      crearFuenteAprendida(c, { tenantId: tenantA, tono: 'Cercano, de tú a tú.', entradas: ENTRADAS }),
    );
    expect(source.status).toBe('por_revisar');
    expect(source.name).toBe(TITULO_DE_LO_APRENDIDO);
    expect(source.kind).toBe('faq');

    const guardado = await withTenant(admin, tenantA, (c) =>
      leerFuenteAprendida(c, { tenantId: tenantA, sourceId: source.id }),
    );
    expect(guardado.tono).toBe('Cercano, de tú a tú.');
    expect(guardado.entradas).toHaveLength(2);
    expect(guardado.entradas[0].pregunta).toBe('¿Hacen despacho?');
    expect(guardado.entradas[1].aviso).toContain('18-11');
    // Sin embeddings: nada indexado hasta aprobar.
    const chunks = await admin.query('SELECT count(*)::int AS n FROM chunks WHERE source_id = $1', [
      source.id,
    ]);
    expect(chunks.rows[0].n).toBe(0);

    const audit = await admin.query('SELECT action FROM audit_log WHERE tenant_id = $1 AND resource_id = $2', [
      tenantA,
      source.id,
    ]);
    expect(audit.rows.map((r) => r.action)).toContain('knowledge.source.aprendido');
  });

  it('sin entradas no se crea una fuente vacía', async () => {
    await expect(
      withTenant(admin, tenantA, (c) =>
        crearFuenteAprendida(c, { tenantId: tenantA, tono: null, entradas: [] }),
      ),
    ).rejects.toThrow('No hay entradas aprendidas');
  });
});

describe('la búsqueda del asistente no lo ve hasta aprobarlo', () => {
  it('una fuente por_revisar NO aparece, aunque tenga chunks', async () => {
    const source = await withTenant(admin, tenantA, (c) =>
      crearFuenteAprendida(c, { tenantId: tenantA, tono: null, entradas: ENTRADAS }),
    );
    // Chunks a mano y con el MISMO texto del que sí va a servir: la prueba
    // tiene que aislar el `status` de `FUENTE_VIGENTE`, no medir que «una
    // fuente nueva no tiene chunks».
    const vector = toVectorLiteral(Array.from({ length: DIMENSIONES }, (_, i) => (i === 0 ? 1 : 0)));
    await admin.query(
      `INSERT INTO chunks (tenant_id, source_id, content, embedding, position)
       VALUES ($1, $2, 'R: Sí, a todo Chile en 3 a 5 días.', $3::halfvec, 0)`,
      [tenantA, source.id, vector],
    );
    await admin.query('DELETE FROM knowledge_query_cache WHERE tenant_id = $1', [tenantA]);
    const r = await withTenant(admin, tenantA, (c) =>
      searchKnowledge(c, { tenantId: tenantA, query: '¿hacen despacho?' }, embedFalso),
    );
    expect(r.hits.map((h) => h.sourceId)).not.toContain(source.id);
  });
});

describe('aprobar, editar y descartar', () => {
  it('aprobar la indexa y la deja activa, con la pregunta como chunk', async () => {
    const source = await withTenant(admin, tenantA, (c) =>
      crearFuenteAprendida(c, { tenantId: tenantA, tono: null, entradas: ENTRADAS }),
    );
    const aprobada = await withTenant(admin, tenantA, (c) =>
      aprobarFuenteAprendida(c, { tenantId: tenantA, sourceId: source.id, actor: 'duenia-1406' }, {
        embed: embedFalso,
      }),
    );
    expect(aprobada.status).toBe('active');
    const chunks = await admin.query('SELECT content, question FROM chunks WHERE source_id = $1 ORDER BY position', [
      source.id,
    ]);
    expect(chunks.rows).toHaveLength(2);
    expect(chunks.rows[0].question).toBe('¿Hacen despacho?');
    expect(chunks.rows[0].content).toContain('Sí, a todo Chile');
    // Aprobada, la búsqueda ya la encuentra.
    await admin.query('DELETE FROM knowledge_query_cache WHERE tenant_id = $1', [tenantA]);
    const r = await withTenant(admin, tenantA, (c) =>
      searchKnowledge(c, { tenantId: tenantA, query: '¿hacen despacho?' }, embedFalso),
    );
    expect(r.hits.map((h) => h.sourceId)).toContain(source.id);
    const audit = await admin.query('SELECT action FROM audit_log WHERE tenant_id = $1 AND resource_id = $2', [
      tenantA,
      source.id,
    ]);
    expect(audit.rows.map((x) => x.action)).toContain('knowledge.source.aprobada');
  });

  it('editar una entrada guarda la corrección y deja auditoría, sin la respuesta en ella', async () => {
    const source = await withTenant(admin, tenantA, (c) =>
      crearFuenteAprendida(c, { tenantId: tenantA, tono: null, entradas: ENTRADAS }),
    );
    const guardado = await withTenant(admin, tenantA, (c) =>
      leerFuenteAprendida(c, { tenantId: tenantA, sourceId: source.id }),
    );
    const id = guardado.entradas[0].id;
    const corregido = await withTenant(admin, tenantA, (c) =>
      editarEntradaAprendida(c, {
        tenantId: tenantA,
        sourceId: source.id,
        entradaId: id,
        respuesta: 'Sí, a todo Chile en 2 a 4 días.',
        actor: 'duenia-1406',
      }),
    );
    expect(corregido.entradas.find((e) => e.id === id)?.respuesta).toContain('2 a 4 días');
    const audit = await admin.query('SELECT action, metadata FROM audit_log WHERE tenant_id = $1 AND resource_id = $2', [
      tenantA,
      source.id,
    ]);
    const edicion = audit.rows.find((r) => r.action === 'knowledge.source.entrada.editada');
    expect(edicion).toBeTruthy();
    expect(edicion.metadata.entrada).toBe(id);
    // La respuesta corregida NO viaja en la auditoría: es contenido del
    // negocio, y duplicarla sería una segunda copia sin dueño.
    expect(JSON.stringify(audit.rows)).not.toContain('2 a 4 días');
  });

  it('descartar saca la entrada, y aprobar sin entradas no se puede', async () => {
    const source = await withTenant(admin, tenantA, (c) =>
      crearFuenteAprendida(c, { tenantId: tenantA, tono: null, entradas: [ENTRADAS[0]] }),
    );
    const guardado = await withTenant(admin, tenantA, (c) =>
      leerFuenteAprendida(c, { tenantId: tenantA, sourceId: source.id }),
    );
    const restado = await withTenant(admin, tenantA, (c) =>
      descartarEntradaAprendida(c, {
        tenantId: tenantA,
        sourceId: source.id,
        entradaId: guardado.entradas[0].id,
        actor: 'duenia-1406',
      }),
    );
    expect(restado.entradas).toHaveLength(0);
    const audit = await admin.query('SELECT action, metadata FROM audit_log WHERE tenant_id = $1 AND resource_id = $2', [
      tenantA,
      source.id,
    ]);
    expect(audit.rows.map((r) => r.action)).toContain('knowledge.source.entrada.descartada');
    // La fuente sigue en la lista, visible: el borrado es decisión aparte.
    const fuentes = await withTenant(admin, tenantA, (c) => listSources(c, tenantA));
    expect(fuentes.map((f) => f.id)).toContain(source.id);
    await expect(
      withTenant(admin, tenantA, (c) =>
        aprobarFuenteAprendida(c, { tenantId: tenantA, sourceId: source.id, actor: 'duenia-1406' }, {
          embed: embedFalso,
        }),
      ),
    ).rejects.toThrow('No quedan entradas');
  });

  it('un negocio no ve ni revisa la fuente aprendida de otro', async () => {
    const source = await withTenant(admin, tenantA, (c) =>
      crearFuenteAprendida(c, { tenantId: tenantA, tono: null, entradas: ENTRADAS }),
    );
    const fuentesDeB = await withTenant(admin, tenantB, (c) => listSources(c, tenantB));
    expect(fuentesDeB.map((f) => f.id)).not.toContain(source.id);
    await expect(
      withTenant(admin, tenantB, (c) =>
        leerFuenteAprendida(c, { tenantId: tenantB, sourceId: source.id }),
      ),
    ).rejects.toThrow('No encontramos esa fuente.');
  });

  it('una fuente que no está por revisar no se revisa', async () => {
    const source = await withTenant(admin, tenantA, (c) =>
      crearFuenteAprendida(c, { tenantId: tenantA, tono: null, entradas: ENTRADAS }),
    );
    await withTenant(admin, tenantA, (c) =>
      aprobarFuenteAprendida(c, { tenantId: tenantA, sourceId: source.id, actor: 'duenia-1406' }, {
        embed: embedFalso,
      }),
    );
    await expect(
      withTenant(admin, tenantA, (c) =>
        leerFuenteAprendida(c, { tenantId: tenantA, sourceId: source.id }),
      ),
    ).rejects.toThrow('Esa fuente no está por revisar');
  });
});
