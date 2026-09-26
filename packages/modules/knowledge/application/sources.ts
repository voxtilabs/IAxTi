import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { writeAudit } from '@iaxti/module-audit';
import { parseCsv } from '@iaxti/module-crm';
import { splitIntoChunks, stripHtml, toVectorLiteral } from '../domain/chunking';
import type { EmbedPort, PdfTextPort, UrlTextPort } from './embeddings';
import { nvidiaEmbedPort, geminiPdfTextPort, DIMENSIONES } from './embeddings';

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
  const embed = ports.embed ?? nvidiaEmbedPort();
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

    const vectores = await embed.embed(
      piezas.map((p) => p.content),
      'pasaje',
    );
    // Se revisa ANTES de tocar la base y no se confía en que la rechace.
    //
    // Un vector del largo equivocado es un error de Postgres, y un error de
    // Postgres aborta la transacción: el `UPDATE ... status = 'failed'` del
    // catch se ejecuta sobre una transacción muerta y se pierde con el
    // rollback. La fuente queda en 'processing' para siempre, y el job de
    // reindexación (#502) la vuelve a tomar cada dos minutos pagándole al
    // proveedor cada vez. Acá el error es de JavaScript, la transacción sigue
    // viva y la fuente queda 'failed' con el motivo a la vista.
    if (vectores.length !== piezas.length) {
      throw new Error(
        `El proveedor devolvió ${vectores.length} vectores para ${piezas.length} pedazos de texto.`,
      );
    }
    const raro = vectores.findIndex((v) => v.length !== DIMENSIONES);
    if (raro !== -1) {
      throw new Error(
        `El proveedor devolvió un vector de ${vectores[raro].length} dimensiones y la tabla espera ${DIMENSIONES}. ¿Cambió el modelo de embeddings?`,
      );
    }
    for (let i = 0; i < piezas.length; i++) {
      await client.query(
        `INSERT INTO chunks (tenant_id, source_id, content, question, embedding, position)
         VALUES ($1,$2,$3,$4,$5::halfvec,$6)`,
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
/**
 * Los tenants a los que les toca vencer fuentes.
 *
 * Sale de `tenants`, no de `sources` (#286): `sources` tiene RLS y esta
 * consulta corre sin `app.tenant_id`, así que con el rol de producción
 * devolvía cero filas — y ninguna lista de precios vencía nunca. La IA
 * habría seguido respondiendo con precios que el negocio dio de baja.
 *
 * Recibe el pool (no un cliente con tenant) a propósito: es el paso previo
 * a entrar a cada uno.
 */
export async function tenantsWithExpirable(client: Pick<PoolClient, 'query'>): Promise<string[]> {
  const r = await client.query(
    `SELECT id FROM tenants WHERE COALESCE(state, 'active') <> 'deleted' ORDER BY created_at`,
  );
  return r.rows.map((x) => x.id);
}

export interface Reindexacion {
  /** Fuentes que quedaron indexadas de nuevo. */
  listas: number;
  /** Fuentes que fallaron: quedan en 'failed' con su motivo, visible en la app. */
  fallidas: number;
  /** true si quedan fuentes pendientes para la próxima pasada. */
  quedanMas: boolean;
}

/**
 * Reindexa las fuentes que quedaron sin vector (#502).
 *
 * Cambiar de modelo de embeddings deja el índice vacío: los vectores viejos
 * son de otro modelo y de otro largo, no se convierten y no se comparan. La
 * migración 0002 los borra y devuelve las fuentes a 'processing'; esto es
 * lo que las vuelve a dejar 'active'. Sin esto, la migración deja a cada
 * negocio con su conocimiento cargado en la app y la IA sin encontrar nada.
 *
 * Va por tandas y no de una: cada fuente paga una llamada al proveedor, y un
 * bucle sobre todos los negocios en un solo job es la forma de que un
 * reintento salga carísimo. `quedanMas` le dice a quien lo llama que vuelva.
 *
 * Las fuentes PDF se quedan afuera a propósito: su texto se extrae del
 * archivo en el momento de subirlo y no se guarda, así que no hay de dónde
 * reindexarlas sin volver a subir el PDF. Hoy no existen —la API rechaza
 * `kind: 'pdf'`— y cuando existan, esto tiene que leer el archivo de R2 por
 * `r2_key`.
 */
export async function reindexarPendientes(
  client: PoolClient,
  tenantId: string,
  ports: ProcessPorts = {},
  porTanda = 5,
): Promise<Reindexacion> {
  const pendientes = await client.query(
    `SELECT id FROM sources
      WHERE tenant_id = $1 AND status = 'processing' AND kind <> 'pdf'
      ORDER BY created_at
      LIMIT $2`,
    [tenantId, porTanda + 1],
  );
  const ids = pendientes.rows.slice(0, porTanda).map((r) => r.id as string);
  let listas = 0;
  let fallidas = 0;
  for (const sourceId of ids) {
    try {
      // OJO: `processSource` no lanza cuando la fuente falla — atrapa el
      // error, deja la fuente en 'failed' con el motivo y la devuelve. Si
      // acá contáramos por el `catch`, toda fuente rota se contaría como
      // lista y el log diría que la reindexación va bien mientras ninguna
      // contesta. El status es el que sabe.
      const r = await processSource(client, { tenantId, sourceId, requestId: 'reindex' }, ports);
      if (r.status === 'active') listas++;
      else fallidas++;
    } catch {
      // Lo que sí lanza es lo que no llegó a ser un fallo de la fuente (la
      // base caída, por ejemplo). Seguimos con la siguiente: una fuente rota
      // no puede dejar sin conocimiento a las demás.
      fallidas++;
    }
  }
  return { listas, fallidas, quedanMas: pendientes.rowCount! > porTanda };
}

/**
 * ¿Tiene este negocio algo esperando reindexación? (#502)
 *
 * Va DENTRO de `withTenant`, igual que todo lo que toca `sources`. La
 * tentación era listar de una los negocios con fuentes pendientes —un solo
 * `SELECT DISTINCT tenant_id FROM sources`— y recorrerlos. Eso funciona con
 * el rol de hoy porque es superusuario: Postgres no evalúa las políticas.
 * Con el rol de aplicación que pide #370 la misma consulta devolvería cero
 * filas y el job no encontraría nada nunca, sin un error en ningún log. El
 * barrido se hace como el de vigencias: los negocios salen de `tenants`, que
 * no filtra por tenant, y el trabajo se hace adentro.
 */
export async function hayQueReindexar(client: PoolClient, tenantId: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM sources
      WHERE tenant_id = $1 AND status = 'processing' AND kind <> 'pdf' LIMIT 1`,
    [tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}
