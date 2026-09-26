import type { PoolClient } from 'pg';
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

export async function searchKnowledge(
  client: PoolClient,
  input: { tenantId: string; query: string; k?: number },
  embedPort: EmbedPort = nvidiaEmbedPort(),
): Promise<KnowledgeResult> {
  const k = input.k ?? 4;
  const query = input.query?.trim() ?? '';
  const vencidas = await client.query(
    `SELECT name FROM sources WHERE tenant_id = $1 AND status = 'expired' ORDER BY updated_at DESC LIMIT 3`,
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
    return { hits: cache.rows[0].results as KnowledgeHit[], cached: true, expiredSources };
  }

  // 'pregunta', no 'pasaje': el modelo es asimétrico y con el rol errado los
  // puntajes se aplastan hasta que el orden lo decide el azar (#502).
  const [vector] = await embedPort.embed([query], 'pregunta');
  const r = await client.query(
    `SELECT c.content, c.question, s.id AS source_id, s.name AS source_name,
            1 - (c.embedding <=> $2::halfvec) AS score
       FROM chunks c
       JOIN sources s ON s.id = c.source_id AND s.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1 AND s.status = 'active'
        AND (s.valid_until IS NULL OR s.valid_until > now())
      ORDER BY c.embedding <=> $2::halfvec
      LIMIT $3`,
    [input.tenantId, toVectorLiteral(vector), k],
  );
  const hits: KnowledgeHit[] = r.rows.map((row) => ({
    content: row.content,
    question: row.question ?? null,
    sourceId: row.source_id,
    sourceName: row.source_name,
    score: Number(row.score),
  }));
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
      WHERE p.tenant_id = $1 AND s.status = 'active'
        AND (s.valid_until IS NULL OR s.valid_until > now())
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
