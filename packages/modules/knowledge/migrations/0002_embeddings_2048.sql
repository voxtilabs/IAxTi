-- #502: los embeddings pasan a NVIDIA, el mismo catálogo que sirve GLM
-- (ADR-0025 §7). Una sola llave `nvapi-` para todo el producto.
--
-- `nvidia/nemotron-3-embed-1b` entrega 2048 dimensiones y son fijas: pedir
-- `dimensions: 1024` responde «dimensions must be one of 2048». Eso choca con
-- pgvector: el índice HNSW sobre `vector` acepta hasta 2000 dimensiones
-- («column cannot have more than 2000 dimensions for hnsw index», medido con
-- pgvector 0.8.6). Así que la columna pasa a `halfvec`, que sí se indexa
-- hasta 4000 — media precisión, la mitad de disco, y para ordenar por coseno
-- la diferencia no se nota.
--
-- Los vectores viejos son de 768 dimensiones y de otro modelo: no se
-- convierten, no se comparan y no se salvan. Se borran y se vuelve a
-- indexar desde la fuente, que es el original y sigue guardado.

DROP INDEX IF EXISTS chunks_embedding_idx;

-- El contenido se va: un chunk sin vector no lo encuentra nadie, y dejarlo
-- ahí sería un índice que parece tener cosas y no responde.
DELETE FROM chunks;

ALTER TABLE chunks DROP COLUMN IF EXISTS embedding;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding halfvec(2048);

CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks USING hnsw (embedding halfvec_cosine_ops);

-- El cache guarda los pasajes YA elegidos con el modelo viejo y sus puntajes
-- en la escala vieja. Servirlo después de cambiar de modelo es contestar con
-- el buscador de ayer durante una hora.
DELETE FROM knowledge_query_cache;

-- Las fuentes vuelven a 'processing': es la verdad — están sin indexar. El
-- job de reindexación (`reindexarTodo`) las toma y las deja 'active'. Si
-- quedaran en 'active' con cero chunks, el negocio vería su conocimiento
-- "cargado" y la IA no encontraría nada: el fallo callado que no queremos.
UPDATE sources SET status = 'processing', error = NULL, updated_at = now()
 WHERE status IN ('active', 'failed');
