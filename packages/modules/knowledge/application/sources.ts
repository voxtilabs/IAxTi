import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { writeAudit } from '@iaxti/module-audit';
import { parseCsv } from '@iaxti/module-crm';
import { splitIntoChunks, stripHtml, toVectorLiteral } from '../domain/chunking';
import type { EmbedPort, PdfTextPort, UrlTextPort } from './embeddings';
import { googleEmbedPort, geminiPdfTextPort } from './embeddings';

// Fuentes (#51, SPEC §14): lo que el negocio DICE. Con vigencia opcional —
// una lista de precios vencida es peor que ninguna: la IA la ignora y avisa.

export type SourceKind = 'texto' | 'pdf' | 'url' | 'faq' | 'catalogo';

export interface Source {
  id: string;
  kind: SourceKind;
  name: string;
  url: string | null;
  validUntil: Date | null;
  status: 'processing' | 'active' | 'expired' | 'failed';
  error: string | null;
  chunkCount?: number;
  createdAt: Date;
}

function rowToSource(row: Record<string, unknown>): Source {
  return {
    id: row.id as string,
    kind: row.kind as SourceKind,
    name: row.name as string,
    url: (row.url as string) ?? null,
    validUntil: (row.valid_until as Date) ?? null,
    status: row.status as Source['status'],
    error: (row.error as string) ?? null,
    chunkCount: row.chunk_count === undefined ? undefined : Number(row.chunk_count),
    createdAt: row.created_at as Date,
  };
}

export interface AddSourceInput {
  tenantId: string;
  kind: SourceKind;
  name: string;
  /** texto pegado, JSON [{q,a}] para faq, o el CSV crudo para catálogo */
  content?: string;
  url?: string;
  r2Key?: string;
  validUntil?: Date | null;
  actor?: string;
  requestId?: string;
}

export async function addSource(client: PoolClient, input: AddSourceInput): Promise<Source> {
  if (!input.name?.trim()) throw new Error('La fuente necesita un nombre.');
  if (input.kind === 'url' && !input.url?.trim()) throw new Error('Falta la URL.');
  if (['texto', 'faq', 'catalogo'].includes(input.kind) && !input.content?.trim()) {
    throw new Error('Falta el contenido de la fuente.');
  }
  if (input.kind === 'pdf' && !input.r2Key) throw new Error('Falta el archivo PDF.');
  const r = await client.query(
    `INSERT INTO sources (tenant_id, kind, name, content, url, r2_key, valid_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.tenantId,
      input.kind,
      input.name.trim(),
      input.content ?? null,
      input.url ?? null,
      input.r2Key ?? null,
      input.validUntil ?? null,
    ],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: 'user',
    action: 'knowledge.source.add',
    resource: 'source',
    resourceId: r.rows[0].id,
    result: 'ok',
    metadata: { kind: input.kind, name: input.name.trim() },
    requestId: input.requestId,
  });
  await publishEvent(client, {
    name: 'knowledge.source_added',
    tenantId: input.tenantId,
    payload: { sourceId: r.rows[0].id, kind: input.kind },
    actor: input.actor ?? 'system',
    requestId: input.requestId,
  });
  return rowToSource(r.rows[0]);
}

interface CatalogRow {
  sku: string | null;
  name: string;
  price: number | null;
  stock: number | null;
  description: string | null;
}

/** El CSV del catálogo: cabeceras flexibles (nombre/producto, precio, stock…). */
export function parseCatalog(csv: string): CatalogRow[] {
  const filas = parseCsv(csv);
  if (filas.length < 2) return [];
  const headers = filas[0].map((h) => h.toLowerCase().trim());
  const col = (...names: string[]) => headers.findIndex((h) => names.includes(h));
  const iNombre = col('nombre', 'producto', 'name', 'servicio');
  const iPrecio = col('precio', 'price', 'valor');
  const iStock = col('stock', 'cantidad', 'existencias');
  const iSku = col('sku', 'codigo', 'código');
  const iDesc = col('descripcion', 'descripción', 'description', 'detalle');
  if (iNombre === -1) throw new Error('El CSV necesita una columna "nombre" o "producto".');
  return filas
    .slice(1)
    .filter((f) => f[iNombre]?.trim())
    .map((f) => {
      const precio = iPrecio === -1 ? NaN : Number(String(f[iPrecio]).replace(/[$.\s]/g, '').replace(',', '.'));
      const stock = iStock === -1 ? NaN : Number(f[iStock]);
      return {
        sku: iSku === -1 ? null : f[iSku]?.trim() || null,
        name: f[iNombre].trim(),
        price: Number.isFinite(precio) ? precio : null,
        stock: Number.isFinite(stock) ? stock : null,
        description: iDesc === -1 ? null : f[iDesc]?.trim() || null,
      };
    });
}

export interface ProcessPorts {
  embed?: EmbedPort;
  pdf?: PdfTextPort;
  urlFetch?: UrlTextPort;
}

/**
 * Procesa (o reprocesa) una fuente: extrae el texto según el kind, trocea,
 * embebe y deja los chunks listos. Re-indexar = borrar y volver a procesar
 * (al cambiar la fuente). Invalida el cache del tenant SIEMPRE.
 */
export async function processSource(
  client: PoolClient,
  input: { tenantId: string; sourceId: string; pdfBytes?: Uint8Array; requestId?: string },
  ports: ProcessPorts = {},
): Promise<Source> {
  const embed = ports.embed ?? googleEmbedPort();
  const r = await client.query('SELECT * FROM sources WHERE tenant_id = $1 AND id = $2', [
    input.tenantId,
    input.sourceId,
  ]);
  if (r.rowCount === 0) throw new Error('No encontramos esa fuente.');
  const source = r.rows[0];

  // Reindexación limpia: chunks y productos viejos fuera (cascade no aplica
  // porque la fuente sigue viva).
  await client.query('DELETE FROM chunks WHERE tenant_id = $1 AND source_id = $2', [
    input.tenantId,
    input.sourceId,
  ]);
  await client.query('DELETE FROM products WHERE tenant_id = $1 AND source_id = $2', [
    input.tenantId,
    input.sourceId,
  ]);
  await client.query('DELETE FROM knowledge_query_cache WHERE tenant_id = $1', [input.tenantId]);

  try {
    let piezas: Array<{ content: string; question?: string }> = [];
    if (source.kind === 'texto') {
      piezas = splitIntoChunks(source.content ?? '').map((content) => ({ content }));
    } else if (source.kind === 'url') {
      const html = ports.urlFetch
        ? await ports.urlFetch.fetch(source.url)
        : await (await fetch(source.url)).text();
      piezas = splitIntoChunks(stripHtml(html)).map((content) => ({ content }));
    } else if (source.kind === 'pdf') {
      if (!input.pdfBytes) throw new Error('Falta el contenido del PDF para procesar.');
      const texto = await (ports.pdf ?? geminiPdfTextPort()).extract({ bytes: input.pdfBytes });
      piezas = splitIntoChunks(texto).map((content) => ({ content }));
    } else if (source.kind === 'faq') {
      const faqs = JSON.parse(source.content ?? '[]') as Array<{ q?: string; a?: string }>;
      piezas = faqs
        .filter((f) => f.q?.trim() && f.a?.trim())
        .map((f) => ({ content: `P: ${f.q!.trim()}\nR: ${f.a!.trim()}`, question: f.q!.trim() }));
    } else if (source.kind === 'catalogo') {
      const productos = parseCatalog(source.content ?? '');
      if (productos.length === 0) throw new Error('El catálogo llegó vacío.');
      for (const p of productos) {
        await client.query(
          `INSERT INTO products (tenant_id, source_id, sku, name, price, stock, description)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [input.tenantId, input.sourceId, p.sku, p.name, p.price, p.stock, p.description],
        );
      }
      // También al índice semántico, para que "¿hacen manicure?" lo encuentre.
      piezas = productos.map((p) => ({
        content: `Producto: ${p.name}${p.price !== null ? ` — precio $${p.price}` : ''}${
          p.stock !== null ? `, stock ${p.stock}` : ''
        }${p.description ? `. ${p.description}` : ''}`,
      }));
    }
    if (piezas.length === 0) throw new Error('La fuente no tiene contenido que indexar.');

    const vectores = await embed.embed(piezas.map((p) => p.content));
    for (let i = 0; i < piezas.length; i++) {
      await client.query(
        `INSERT INTO chunks (tenant_id, source_id, content, question, embedding, position)
         VALUES ($1,$2,$3,$4,$5::vector,$6)`,
        [
          input.tenantId,
          input.sourceId,
          piezas[i].content,
          piezas[i].question ?? null,
          toVectorLiteral(vectores[i]),
          i,
        ],
      );
    }
    const listo = await client.query(
      `UPDATE sources SET status = 'active', error = NULL, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [input.tenantId, input.sourceId],
    );
    await publishEvent(client, {
      name: 'knowledge.reindexed',
      tenantId: input.tenantId,
      payload: { sourceId: input.sourceId, chunks: piezas.length },
      actor: 'system',
      requestId: input.requestId,
    });
    return rowToSource(listo.rows[0]);
  } catch (err) {
    const fallo = await client.query(
      `UPDATE sources SET status = 'failed', error = $3, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [input.tenantId, input.sourceId, (err as Error).message],
    );
    return rowToSource(fallo.rows[0]);
  }
}

export async function listSources(client: PoolClient, tenantId: string): Promise<Source[]> {
  const r = await client.query(
    `SELECT s.*, (SELECT count(*) FROM chunks c WHERE c.tenant_id = s.tenant_id AND c.source_id = s.id) AS chunk_count
       FROM sources s WHERE s.tenant_id = $1 ORDER BY s.created_at DESC`,
    [tenantId],
  );
  return r.rows.map(rowToSource);
}

export async function deleteSource(
  client: PoolClient,
  input: { tenantId: string; sourceId: string; actor: string; requestId?: string },
): Promise<void> {
  const r = await client.query('DELETE FROM sources WHERE tenant_id = $1 AND id = $2', [
    input.tenantId,
    input.sourceId,
  ]);
  if (r.rowCount === 0) throw new Error('No encontramos esa fuente.');
  await client.query('DELETE FROM knowledge_query_cache WHERE tenant_id = $1', [input.tenantId]);
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'knowledge.source.delete',
    resource: 'source',
    resourceId: input.sourceId,
    result: 'ok',
    requestId: input.requestId,
  });
}

/**
 * Marca vencidas las fuentes con vigencia pasada y AVISA (SPEC §14): una
 * lista de precios vencida no responde más. Corre en la cola scheduled.
 */
export async function expireSources(client: PoolClient, tenantId: string): Promise<number> {
  const r = await client.query(
    `UPDATE sources SET status = 'expired', updated_at = now()
      WHERE tenant_id = $1 AND status = 'active' AND valid_until IS NOT NULL AND valid_until < now()
      RETURNING id, name`,
    [tenantId],
  );
  for (const fila of r.rows) {
    await publishEvent(client, {
      name: 'knowledge.source_expired',
      tenantId,
      payload: { sourceId: fila.id, name: fila.name },
      actor: 'system',
    });
  }
  if ((r.rowCount ?? 0) > 0) {
    await client.query('DELETE FROM knowledge_query_cache WHERE tenant_id = $1', [tenantId]);
  }
  return r.rowCount ?? 0;
}

/** Tenants con fuentes por vencer (para el job scheduled sin RLS global). */
export async function tenantsWithExpirable(client: Pick<PoolClient, 'query'>): Promise<string[]> {
  const r = await client.query(
    `SELECT DISTINCT tenant_id FROM sources
      WHERE status = 'active' AND valid_until IS NOT NULL AND valid_until < now()`,
  );
  return r.rows.map((x) => x.tenant_id);
}
