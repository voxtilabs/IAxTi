import type { PoolClient, QueryResultRow } from 'pg';
import { hashQuery, toVectorLiteral } from '../domain/chunking';
import type { EmbedPort } from './embeddings';
import { nvidiaEmbedPort } from './embeddings';

// El retrieval (#51): top-K por coseno SOLO sobre fuentes vigentes, con la
// cita a la fuente SIEMPRE — que la IA responda con lo que el negocio dice.

export interface KnowledgeHit {
  content: string;
  question: string | null;
  sourceId: string;
  sourceName: string;
  score: number;
}

export interface KnowledgeResult {
  hits: KnowledgeHit[];
  /** true si vino del cache del tenant (no pagó embedding). */
  cached: boolean;
  /** Fuentes vencidas que el tenant debiera renovar (la IA las ignora). */
  expiredSources: string[];
}

const CACHE_TTL = "interval '1 hour'";

/**
 * Una fuente deja de servir cuando su vigencia pasó, y eso es AHORA, no
 * cuando el barrido se entere.
 *
 * `expireSources` (el job scheduled) es quien pone `status = 'expired'` y
 * avisa, pero corre cada tanto. Entre que el reloj pasa `valid_until` y que el
 * barrido llega, la fuente sigue en 'active' — y una lista de precios que
 * venció hace media hora no se puede citar como vigente ni un minuto más. Por
 * eso todo lo que decide qué se puede usar mira las DOS cosas: el estado y el
 * reloj.
 */
const FUENTE_VIGENTE = `s.status = 'active' AND (s.valid_until IS NULL OR s.valid_until > now())`;

const SQL_PASAJES = `SELECT c.content, c.question, s.id AS source_id, s.name AS source_name,
            1 - (c.embedding <=> $2::halfvec) AS score
       FROM chunks c
       JOIN sources s ON s.id = c.source_id AND s.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1 AND ${FUENTE_VIGENTE}
      ORDER BY c.embedding <=> $2::halfvec
      LIMIT $3`;

/**
 * Los K pasajes más parecidos DEL TENANT, y que sean del tenant no es un
 * detalle del WHERE: es justo lo que el índice no garantiza solo.
 *
 * pgvector aplica el `WHERE` DESPUÉS de que el índice HNSW entregó sus
 * candidatos (en el plan se ve como `Index Scan using chunks_embedding_idx`
 * con `Filter: tenant_id = ...`). Con `hnsw.ef_search` en 40 por defecto, el
 * índice entrega los ~40 vecinos más cercanos de TODA la tabla y recién
 * después se botan los de otros negocios: si esos 40 vecinos son del negocio
 * grande, el negocio chico recibe CERO pasajes propios teniéndolos. Y cero
 * pasajes no es un error que se vea — es la IA contestando sin el conocimiento
 * del negocio, que es exactamente lo que este módulo existe para evitar.
 * Medido en local (pgvector 0.8.6, halfvec de 2048): 120 pasajes de otro
 * negocio y uno del chico, forzando el plan que produce una tabla grande,
 * devuelve 0 filas.
 *
 * La doc de pgvector ofrece dos salidas para filtrar con índice:
 *
 * 1. Índices parciales, uno por valor del filtro. Acá el filtro es el tenant y
 *    los tenants se crean solos al contratar: sería un `CREATE INDEX` por alta
 *    y cientos de índices HNSW sobre la misma tabla. No.
 * 2. `hnsw.iterative_scan` (pgvector ≥ 0.8): el índice sigue entregando
 *    vecinos hasta juntar los K que pasan el filtro. Eso es lo que hace falta.
 *    `relaxed_order` y no `strict_order` porque el orden fino lo reordenamos
 *    nosotros por `score` y así se escanea menos.
 *
 * Y una red de seguridad, porque el barrido iterativo tampoco es infinito: se
 * detiene en `hnsw.max_scan_tuples` (20.000 por defecto), así que un negocio
 * con diez pasajes dentro de una tabla de un millón puede quedar fuera igual.
 * Si vinieron menos de K, se repite la búsqueda con el índice ANN apagado: el
 * plan pasa a bitmap por `chunks_tenant_idx` más orden, o sea coseno EXACTO
 * sobre los pasajes de ese tenant y nada más. El costo queda acotado al
 * negocio y no a la tabla, y es precisamente el caso del negocio chico: el que
 * menos pasajes tiene y el que más se estaba quedando sin ellos.
 *
 * Los dos parámetros se devuelven a su valor al salir, y eso NO es adorno: el
 * `SET LOCAL` muere con la transacción, pero la transacción no es de esta
 * función — es la del llamador (`withTenant`, compartida con toda la corrida
 * del agente). Sin el `RESET`, cualquier consulta vectorial posterior de esa
 * misma corrida hereda `relaxed_order` sin haberlo pedido, y ahí el
 * comportamiento de un módulo pasa a depender de si otro buscó antes. Es la
 * clase de fuga que este repo ya paga en otros lados; acá se cierra.
 *
 * Un pgvector anterior a 0.8 no conoce el parámetro y lo deja como marcador sin
 * efecto; la red de seguridad sigue devolviendo lo correcto.
 */
async function pasajesDelTenant(
  client: PoolClient,
  tenantId: string,
  vector: string,
  k: number,
): Promise<KnowledgeHit[]> {
  await client.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
  let filas: QueryResultRow[];
  try {
    filas = (await client.query(SQL_PASAJES, [tenantId, vector, k])).rows;
    if (filas.length < k) {
      await client.query('SET LOCAL enable_indexscan = off');
      try {
        filas = (await client.query(SQL_PASAJES, [tenantId, vector, k])).rows;
      } finally {
        // Solo para esta consulta: la transacción sigue y el resto del trabajo
        // del copiloto necesita sus índices.
        await client.query('RESET enable_indexscan');
      }
    }
  } finally {
    // Lo mismo, y por el mismo motivo: la transacción es del llamador.
    await client.query('RESET hnsw.iterative_scan');
  }
  return filas
    .map((row) => ({
      content: row.content as string,
      question: (row.question as string) ?? null,
      sourceId: row.source_id as string,
      sourceName: row.source_name as string,
      score: Number(row.score),
    }))
    // Con `relaxed_order` el índice puede entregar los vecinos levemente
    // desordenados. `hits[0]` es el mejor pasaje para quien lo consume, así que
    // el orden se asegura acá y no se hereda del plan.
    .sort((a, b) => b.score - a.score);
}

/**
 * Los pasajes guardados en el cache sirven solo si sus fuentes siguen
 * vigentes.
 *
 * El cache guarda por una hora los pasajes YA elegidos, y eso está bien para
 * ahorrarse el embedding. Pero dentro de esa hora una fuente puede vencer,
 * apagarse o borrarse, y entonces el cache queda citando como vigente algo que
 * ya no lo es: la lista de precios que venció hace media hora. Así que se
 * revisa contra las fuentes de verdad; si alguna ya no sirve, el cache se
 * ignora y se busca de nuevo. Se paga un embedding — la palanca de costo de
 * §40 cede ante el precio equivocado.
 */
async function elCacheSigueSirviendo(
  client: PoolClient,
  tenantId: string,
  hits: KnowledgeHit[],
): Promise<boolean> {
  const fuentes = [...new Set(hits.map((h) => h.sourceId))];
  if (fuentes.length === 0) return true;
  const vigentes = await client.query(
    `SELECT s.id FROM sources s
      WHERE s.tenant_id = $1 AND s.id = ANY($2::uuid[]) AND ${FUENTE_VIGENTE}`,
    [tenantId, fuentes],
  );
  return vigentes.rowCount === fuentes.length;
}

export async function searchKnowledge(
  client: PoolClient,
  input: { tenantId: string; query: string; k?: number },
  embedPort: EmbedPort = nvidiaEmbedPort(),
): Promise<KnowledgeResult> {
  const k = input.k ?? 4;
  const query = input.query?.trim() ?? '';
  // Vencida es vencida por el reloj, aunque el barrido todavía no haya pasado:
  // esperando el `status = 'expired'`, durante esa ventana la fuente no se usa
  // (arriba) y ADEMÁS no se avisa, que es la peor combinación — la IA contesta
  // sin el dato y sin decir que el dato está vencido.
  const vencidas = await client.query(
    `SELECT name FROM sources
      WHERE tenant_id = $1
        AND (status = 'expired'
             OR (status = 'active' AND valid_until IS NOT NULL AND valid_until <= now()))
      ORDER BY updated_at DESC LIMIT 3`,
    [input.tenantId],
  );
  const expiredSources = vencidas.rows.map((r) => r.name);
  if (!query) return { hits: [], cached: false, expiredSources };

  const hash = hashQuery(query);
  const cache = await client.query(
    `SELECT results FROM knowledge_query_cache
      WHERE tenant_id = $1 AND query_hash = $2 AND created_at > now() - ${CACHE_TTL}`,
    [input.tenantId, hash],
  );
  if ((cache.rowCount ?? 0) > 0) {
    const guardados = cache.rows[0].results as KnowledgeHit[];
    if (await elCacheSigueSirviendo(client, input.tenantId, guardados)) {
      return { hits: guardados, cached: true, expiredSources };
    }
  }

  // 'pregunta', no 'pasaje': el modelo es asimétrico y con el rol errado los
  // puntajes se aplastan hasta que el orden lo decide el azar (#502).
  const [vector] = await embedPort.embed([query], 'pregunta');
  const hits = await pasajesDelTenant(client, input.tenantId, toVectorLiteral(vector), k);
  await client.query(
    `INSERT INTO knowledge_query_cache (tenant_id, query_hash, results)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, query_hash) DO UPDATE SET results = $3, created_at = now()`,
    [input.tenantId, hash, JSON.stringify(hits)],
  );
  return { hits, cached: false, expiredSources };
}

export interface ProductHit {
  sku: string | null;
  name: string;
  price: number | null;
  currency: string;
  stock: number | null;
  description: string | null;
  sourceName: string;
}

/**
 * La tool `knowledge.get_product` (#51): precio y stock como CAMPOS desde
 * el catálogo — el dato exacto, jamás inventado.
 */
export async function getProduct(
  client: PoolClient,
  tenantId: string,
  query: string,
): Promise<ProductHit[]> {
  const q = `%${query.trim()}%`;
  const r = await client.query(
    `SELECT p.sku, p.name, p.price, p.currency, p.stock, p.description, s.name AS source_name
       FROM products p
       JOIN sources s ON s.id = p.source_id AND s.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND ${FUENTE_VIGENTE}
        AND (p.name ILIKE $2 OR p.sku ILIKE $2 OR p.description ILIKE $2)
      ORDER BY p.name LIMIT 5`,
    [tenantId, q],
  );
  return r.rows.map((row) => ({
    sku: row.sku ?? null,
    name: row.name,
    price: row.price === null ? null : Number(row.price),
    currency: row.currency,
    stock: row.stock ?? null,
    description: row.description ?? null,
    sourceName: row.source_name,
  }));
}

/**
 * El bloque de conocimiento para el prompt del copiloto: pasajes CON su
 * fuente y la instrucción de citar. Si hay fuentes vencidas, se avisa.
 */
export function knowledgeContext(result: KnowledgeResult): string | null {
  if (result.hits.length === 0 && result.expiredSources.length === 0) return null;
  const partes: string[] = [];
  if (result.hits.length > 0) {
    partes.push(
      'CONOCIMIENTO DEL NEGOCIO (responde SOLO con esto; cita la fuente entre paréntesis, p. ej. "(según Lista de precios)"):',
      ...result.hits.map((h) => `— [${h.sourceName}] ${h.content}`),
    );
  }
  if (result.expiredSources.length > 0) {
    partes.push(
      `OJO: estas fuentes están VENCIDAS y no se pueden usar: ${result.expiredSources.join(', ')}. Si la respuesta dependía de ellas, dilo o escala.`,
    );
  }
  return partes.join('\n');
}
