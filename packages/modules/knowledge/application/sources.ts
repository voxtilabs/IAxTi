import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@iaxti/db';
import { publishEvent, type AlmacenObjetos } from '@iaxti/core';
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
  /**
   * `delete_failed` es «fuente viva, archivo destruido» (#631): el borrado sacó
   * el archivo de R2 y la transacción no llegó a confirmar. No es 'failed' —esa
   * es la fuente que no se pudo INDEXAR, que se arregla reintentando— porque la
   * acción que corresponde es otra: volver a subir el documento o terminar de
   * borrar la fuente.
   */
  status: 'processing' | 'active' | 'expired' | 'failed' | 'delete_failed';
  error: string | null;
  chunkCount?: number;
  createdAt: Date;
  /**
   * Cuándo se usó por última vez y cuántas veces (#714).
   *
   * «Usar» una fuente es que el retrieval la haya devuelto como respaldo de una
   * respuesta — no que alguien la haya abierto en la pantalla. Es lo que
   * contesta la pregunta que importa: de los ocho documentos que subí, ¿cuáles
   * sostienen lo que la IA dice?
   *
   * `lastUsedAt` en null significa NUNCA, y eso se muestra distinto: una fuente
   * que nadie usó está costando indexación y contexto sin devolver nada.
   */
  lastUsedAt: Date | null;
  useCount: number;
  /**
   * Los `[[enlaces]]` que traía el markdown, con el destino resuelto si existe
   * (#714). Solo cuando la consulta los trae al lado.
   */
  enlaces?: SourceLink[];
}

/** Un `[[enlace]]` de un markdown importado y a qué apunta hoy (#714). */
export interface SourceLink {
  /** El nombre tal cual lo escribió quien redactó el documento. */
  nombre: string;
  /**
   * La fuente a la que apunta, o null si ese documento todavía no está.
   *
   * Se resuelve al LEER y no al importar: en una carpeta, `precios.md` nombra
   * `[[despacho]]` antes de que `despacho.md` entre. Un enlace suelto no es un
   * error, es un documento que falta.
   */
  sourceId: string | null;
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
    lastUsedAt: (row.last_used_at as Date) ?? null,
    useCount: Number(row.use_count ?? 0),
    ...(row.enlaces === undefined ? {} : { enlaces: row.enlaces as SourceLink[] }),
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
  /**
   * Los `[[enlaces]]` del markdown de origen (#714).
   *
   * `fuenteDesdeMarkdown` los venía extrayendo desde el primer día y la ruta de
   * importación los devolvía en la respuesta HTTP: nadie los guardaba. Se
   * registran acá, en la misma transacción que la fuente, porque son parte de
   * lo que ese documento dice.
   */
  enlaces?: string[];
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
  // Los enlaces del documento, si traía (#714). `ON CONFLICT DO NOTHING`
  // porque el mismo `[[precios]]` puede aparecer tres veces en un texto y la
  // relación es una sola — `enlacesDe` ya desduplica, y esto cubre el reintento.
  if (input.enlaces?.length) {
    await client.query(
      `INSERT INTO source_links (tenant_id, source_id, target_name)
       SELECT $1, $2, unnest($3::text[])
       ON CONFLICT DO NOTHING`,
      [input.tenantId, r.rows[0].id, input.enlaces],
    );
  }
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
  /**
   * Baja el PDF de donde esté guardado, por su `r2_key` (#522).
   *
   * Lo inyecta quien llama porque este módulo no conoce R2 ni firma nada: la
   * llave y la firma son de `core`, y el módulo solo pide «tráeme esto».
   *
   * Hasta ahora `r2_key` se escribía y NO se leía nunca, así que una fuente
   * PDF no se podía reprocesar sin volver a subir el archivo — y de hecho no
   * se podía ni crear, porque la API rechazaba `kind: 'pdf'`.
   */
  bajarArchivo?: (r2Key: string) => Promise<Uint8Array>;
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
      // Los bytes vienen del caller (recién subido) o se bajan por su llave.
      // Esto último es lo que permite REINDEXAR un PDF sin volver a subirlo,
      // que es lo que faltaba: el archivo ya estaba guardado y nadie lo leía.
      const bytes =
        input.pdfBytes ??
        (source.r2_key && ports.bajarArchivo
          ? await ports.bajarArchivo(source.r2_key as string)
          : null);
      if (!bytes) {
        throw new Error(
          source.r2_key
            ? 'No pudimos bajar el PDF guardado para volver a leerlo.'
            : 'Falta el archivo del PDF para procesar.',
        );
      }
      const texto = await (ports.pdf ?? geminiPdfTextPort()).extract({ bytes });
      if (!texto.trim()) {
        // Un PDF escaneado sin OCR devuelve vacío. Decirlo así importa: el
        // negocio cree que subió su lista de precios y la IA no encuentra
        // nada, y el motivo no es el producto.
        throw new Error(
          'De ese PDF no salió texto. Si es un escaneo o una foto, pega el contenido como texto.',
        );
      }
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
  // Los enlaces vienen resueltos acá y no en otra vuelta (#714): el destino se
  // busca POR NOMBRE contra las fuentes del mismo tenant, que es lo que hace
  // que un enlace se encienda cuando el documento que falta aparece. El
  // `LEFT JOIN` es lo que deja pasar al enlace suelto con `sourceId: null` en
  // vez de borrarlo de la lista — un enlace sin destino dice que falta algo.
  const r = await client.query(
    `SELECT s.*,
            (SELECT count(*) FROM chunks c WHERE c.tenant_id = s.tenant_id AND c.source_id = s.id) AS chunk_count,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('nombre', l.target_name, 'sourceId', d.id)
                               ORDER BY l.target_name)
                FROM source_links l
                LEFT JOIN sources d
                       ON d.tenant_id = l.tenant_id AND lower(d.name) = lower(l.target_name)
               WHERE l.tenant_id = s.tenant_id AND l.source_id = s.id
            ), '[]'::jsonb) AS enlaces
       FROM sources s WHERE s.tenant_id = $1 ORDER BY s.created_at DESC`,
    [tenantId],
  );
  return r.rows.map(rowToSource);
}

/**
 * Deja constancia de que estas fuentes respaldaron una respuesta (#714).
 *
 * Vive acá y la llama `searchKnowledge`, o sea TODO el que consulta el
 * conocimiento: el copiloto cuando arma su contexto y la herramienta
 * `knowledge.search` cuando el modelo la pide. Una regla, una implementación —
 * si estuviera en el copiloto, lo que la IA consulta por herramienta no contaría
 * y la pantalla diría que esa fuente no se usa nunca.
 *
 * Sí: es una escritura en un camino de lectura. Es una sola `UPDATE` por
 * consulta sobre una tabla de decenas de filas, y el dato no se puede derivar de
 * otra parte — la alternativa es no saberlo.
 */
export async function marcarFuentesUsadas(
  client: PoolClient,
  input: { tenantId: string; sourceIds: readonly string[] },
): Promise<void> {
  if (input.sourceIds.length === 0) return;
  await client.query(
    `UPDATE sources SET last_used_at = now(), use_count = use_count + 1
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [input.tenantId, [...new Set(input.sourceIds)]],
  );
}

/**
 * Saca una fuente del conocimiento: la fila, su índice y —si era un archivo—
 * el archivo mismo.
 *
 * Lo último es el arreglo: antes se borraba la fila y el PDF se quedaba en el
 * bucket, todavía bajable con una URL firmada por cualquiera con permiso de
 * lectura del tenant. El negocio veía la fuente desaparecer de la lista y
 * entendía —con razón— que había sacado el documento, cuando en realidad solo
 * se había sacado el índice. Una lista de precios vieja, un contrato, una
 * tabla de comisiones: seguían ahí.
 *
 * Si el archivo no se puede borrar, esto LANZA y la transacción se deshace: la
 * fuente sigue en la lista, que es la verdad, en vez de desaparecer de la
 * pantalla mientras el documento sigue en pie. Borrar en R2 es idempotente, así
 * que reintentar es seguro.
 *
 * ## Por qué acá se borra DENTRO de la transacción y en `retention.ts` DESPUÉS
 *
 * Son las dos formas opuestas de resolver lo mismo y el repo tiene las dos.
 * `conversations/application/retention.ts` comparte la intención en la base,
 * hace commit y borra después («idempotente: un 404 es éxito»). Acá se borra
 * primero y se deshace la base si el bucket falla. Un revisor con razón
 * pregunta cuál es la buena, porque sin respuesta escrita el próximo tira una
 * moneda — y eso ya pasó una vez esta noche.
 *
 * La regla, y explica los dos casos que ya existen:
 *
 * - **Alguien está esperando y es UN objeto** (esto): se borra primero. Si
 *   falla, la fila vuelve y la persona recibe «no pudimos borrarla, intenta de
 *   nuevo». Eso es honesto y se reintenta apretando otra vez. Después del
 *   commit no habría a quién contarle, y quedaría un huérfano silencioso.
 * - **Nadie está esperando y son MILES de objetos** (`retention.ts`): se
 *   comparte la intención, se hace commit y se borra después. No se puede tener
 *   una transacción abierta durante miles de llamadas de red, y un barrido no
 *   tiene pantalla donde avisar: lo que necesita es poder reconciliar en la
 *   pasada siguiente.
 *
 * O sea: no es inconsistencia, es quién puede recibir la mala noticia.
 *
 * Queda un hueco chico y hay que decirlo: si el borrado en R2 sale bien y el
 * COMMIT falla después, la fila vuelve y los bytes ya no están — «fuente viva,
 * archivo destruido». La búsqueda del conocimiento no puede ver ese estado y
 * seguiría citando un PDF que nadie puede bajar. Necesita marca en la fila para
 * que el criterio de vigencia la excluya, y eso pide su migración: está pedido
 * aparte, no tapado.
 */
export async function deleteSource(
  client: PoolClient,
  input: {
    tenantId: string;
    sourceId: string;
    actor: string;
    requestId?: string;
    /**
     * El bucket. OBLIGATORIO, y no con un `undefined` que significa «tomá el
     * del ambiente»: `almacenR2()` lee las `R2_*` en el momento de la llamada, y
     * `apps/api/tests/equipo.test.ts` las escribe a nivel de PROCESO. Vitest
     * corre varios archivos en hilos que comparten `process.env` —está escrito
     * en `apps/api/src/db.ts`—, así que con el defecto ambiental esta función
     * cambiaba de comportamiento según qué archivo estuviera corriendo al lado.
     * Un `null` explícito es «este ambiente no tiene almacén»; el que decide es
     * quien llama, que es el único que lo sabe.
     */
    almacen: AlmacenObjetos | null;
  },
): Promise<{ archivoDestruido: boolean }> {
  // RETURNING porque la llave del archivo se necesita DESPUÉS de borrar la
  // fila y después ya no hay dónde leerla.
  const r = await client.query(
    'DELETE FROM sources WHERE tenant_id = $1 AND id = $2 RETURNING kind, r2_key',
    [input.tenantId, input.sourceId],
  );
  if (r.rowCount === 0) throw new Error('No encontramos esa fuente.');
  await client.query('DELETE FROM knowledge_query_cache WHERE tenant_id = $1', [input.tenantId]);

  const r2Key = (r.rows[0].r2_key as string | null) ?? null;
  let archivoBorrado = false;
  let archivoCompartido = false;
  if (r2Key) {
    // Otra fuente puede apuntar al mismo archivo (se subió una vez y se creó
    // la fuente dos). Si queda alguna, el archivo NO se toca: borrarlo dejaría
    // a esa otra fuente sin su documento, y eso no se deshace.
    const otras = await client.query(
      'SELECT 1 FROM sources WHERE tenant_id = $1 AND r2_key = $2 LIMIT 1',
      [input.tenantId, r2Key],
    );
    archivoCompartido = (otras.rowCount ?? 0) > 0;
    if (!archivoCompartido) {
      const almacen = input.almacen;
      if (!almacen) {
        throw new Error(
          'Esta fuente tiene un archivo guardado y este ambiente no tiene el almacenamiento ' +
            'configurado (revisa R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY y ' +
            'R2_BUCKET_ADJUNTOS). No la eliminamos: borrar la fila dejaría el archivo bajable.',
        );
      }
      const { fallidas } = await almacen.borrar([r2Key]);
      if (fallidas.length > 0) {
        throw new Error(
          'No pudimos borrar el archivo de esta fuente del almacenamiento, así que no la ' +
            'eliminamos: la fuente seguiría bajable. Vuelve a intentarlo en unos minutos.',
        );
      }
      archivoBorrado = true;
    }
  }

  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'knowledge.source.delete',
    resource: 'source',
    resourceId: input.sourceId,
    result: 'ok',
    requestId: input.requestId,
    metadata: {
      kind: r.rows[0].kind,
      teniaArchivo: Boolean(r2Key),
      archivoBorrado,
      // Queda escrito cuando el archivo se conserva a propósito: sin esto, la
      // auditoría de dos fuentes idénticas se vería igual y una mentiría.
      archivoCompartido,
    },
  });
  // Lo devuelve, y esto no es cosmético (#631): el único que puede enterarse de
  // que el COMMIT falló DESPUÉS de destruir el archivo es quien está afuera de
  // la transacción. Desde acá adentro ese momento no se ve. `eliminarFuente`
  // —abajo— es quien junta las dos cosas; si algún día alguien llama a
  // `deleteSource` directo y tira este dato a la basura, el estado «fuente viva,
  // archivo destruido» vuelve a ser invisible.
  return { archivoDestruido: archivoBorrado };
}

/**
 * Marca una fuente como «su archivo ya no está» (#631).
 *
 * Recibe el POOL y no un cliente, a propósito: se llama justo después de que una
 * transacción se deshizo, y ese cliente ya no sirve para escribir nada. La marca
 * tiene que viajar por una conexión aparte o no viaja.
 *
 * No limpia `knowledge_query_cache`: el chequeo de frescura (#621) ya pide
 * `FUENTE_VIGENTE` sobre cada fuente citada, y `delete_failed` no la cumple. Un
 * `DELETE` más acá sería un segundo lugar donde se decide lo mismo.
 */
export async function marcarFuenteSinArchivo(
  pool: Pool,
  input: { tenantId: string; sourceId: string },
): Promise<void> {
  await withTenant(pool, input.tenantId, async (client) => {
    await client.query(
      `UPDATE sources
          SET status = 'delete_failed',
              error = 'Se eliminó el archivo guardado y la eliminación de la fuente no llegó a completarse. Vuelve a subir el documento o termina de borrar la fuente.',
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.sourceId],
    );
    await writeAudit(client, {
      tenantId: input.tenantId,
      actor: 'system',
      actorKind: 'system',
      action: 'knowledge.source.sin_archivo',
      resource: 'source',
      resourceId: input.sourceId,
      result: 'ok',
      metadata: { motivo: 'el archivo se borró y la transacción no confirmó' },
    });
  });
}

/**
 * Elimina una fuente, con su archivo, y deja constancia si queda a medias
 * (#631).
 *
 * Esto es el pegamento que la ruta necesitaba y no tenía. `deleteSource` corre
 * DENTRO de una transacción y el hueco está justo afuera: entre que el archivo
 * se destruyó y que el COMMIT confirma. Si ese COMMIT falla, la fila vuelve sin
 * su archivo y nadie lo anota.
 *
 * Vive en el módulo y no en el controlador para que el pegamento sea uno. Si
 * cada llamador tuviera que acordarse de marcar, el estado invisible volvería
 * por el primero que no se acordó.
 *
 * ## Lo que esto NO cubre, y la decisión
 *
 * Si el proceso MUERE entre el borrado en R2 y el commit, nadie marca nada: la
 * fila queda 'active' sin archivo y se cita igual. Taparlo pide anotar la
 * intención ANTES de tocar R2 y que un barrido reconcilie, y eso no se puede
 * hacer sobre la misma fila: la transacción que está borrando tiene el candado,
 * así que una conexión aparte se quedaría esperándola. Pide su propia tabla y su
 * propio barrido, y está en #751 con su riesgo residual nombrado en vez de
 * insinuado acá.
 */
export async function eliminarFuente(
  pool: Pool,
  input: {
    tenantId: string;
    sourceId: string;
    actor: string;
    requestId?: string;
    almacen: AlmacenObjetos | null;
  },
): Promise<void> {
  let archivoDestruido = false;
  try {
    await withTenant(pool, input.tenantId, async (client) => {
      ({ archivoDestruido } = await deleteSource(client, input));
    });
  } catch (error) {
    // La marca va antes de propagar el error, y en su propia conexión. El orden
    // importa: si se dejara para después del `throw`, no habría después.
    //
    // Y si la marca TAMPOCO se puede escribir —la base sigue caída—, el error
    // que se propaga es el ORIGINAL: es el que explica qué pasó. Reemplazarlo
    // por «no pude marcar la fuente» le cambiaría el problema a quien lo lee.
    // Esa fila queda sin marcar, y es el mismo riesgo residual que el proceso
    // que muere a medias: está nombrado arriba y en su issue, no tapado.
    if (archivoDestruido) await marcarFuenteSinArchivo(pool, input).catch(() => undefined);
    throw error;
  }
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
 * Las fuentes PDF entran solo si se inyecta `bajarArchivo` (#522): su texto
 * se extrae del archivo, no se guarda, y sin poder bajarlo de nuevo un
 * reintento es gasto puro. Con el puerto puesto sí se reindexan, que es lo
 * que antes era imposible — `r2_key` se escribía y no se leía nunca.
 */
export async function reindexarPendientes(
  client: PoolClient,
  tenantId: string,
  ports: ProcessPorts = {},
  porTanda = 5,
): Promise<Reindexacion> {
  // Los PDF entran solo si quien llama sabe bajarlos (#522): sin eso, su
  // texto no se puede volver a extraer y reintentar sería gastar por nada.
  const pendientes = await client.query(
    `SELECT id FROM sources
      WHERE tenant_id = $1 AND status = 'processing'
        AND (kind <> 'pdf' OR ($2 AND r2_key IS NOT NULL))
      ORDER BY created_at
      LIMIT $3`,
    [tenantId, Boolean(ports.bajarArchivo), porTanda + 1],
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
export async function hayQueReindexar(
  client: PoolClient,
  tenantId: string,
  conArchivos = false,
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM sources
      WHERE tenant_id = $1 AND status = 'processing'
        AND (kind <> 'pdf' OR ($2 AND r2_key IS NOT NULL))
      LIMIT 1`,
    [tenantId, conArchivos],
  );
  return (r.rowCount ?? 0) > 0;
}
