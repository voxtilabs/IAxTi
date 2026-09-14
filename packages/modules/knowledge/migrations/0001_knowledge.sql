-- knowledge (#51, SPEC §14): RAG multi-tenant. Los embeddings viven en
-- pgvector CON tenant_id y RLS — el conocimiento de un negocio jamás
-- responde preguntas de otro.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  kind        text NOT NULL CHECK (kind IN ('texto','pdf','url','faq','catalogo')),
  name        text NOT NULL,
  content     text,          -- el original: texto pegado, JSON de FAQs o CSV
  url         text,
  r2_key      text,          -- PDFs: el archivo vive en R2
  valid_until timestamptz,   -- vigencia opcional: vencida, la IA la ignora
  status      text NOT NULL DEFAULT 'processing'
              CHECK (status IN ('processing','active','expired','failed')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sources_tenant_idx ON sources (tenant_id, created_at DESC);
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sources') THEN
    CREATE POLICY tenant_isolation ON sources
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- text-embedding-004 entrega 768 dimensiones.
CREATE TABLE IF NOT EXISTS chunks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  source_id  uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content    text NOT NULL,
  question   text,           -- FAQs: la pregunta original, para mostrarla
  embedding  vector(768),
  position   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunks_tenant_idx ON chunks (tenant_id, source_id);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks USING hnsw (embedding vector_cosine_ops);
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'chunks') THEN
    CREATE POLICY tenant_isolation ON chunks
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- El catálogo: precio y stock como CAMPOS, no como prosa (SPEC §14).
CREATE TABLE IF NOT EXISTS products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  source_id   uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  sku         text,
  name        text NOT NULL,
  price       numeric(14,2),
  currency    text NOT NULL DEFAULT 'CLP',
  stock       int,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_tenant_idx ON products (tenant_id, name);
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'products') THEN
    CREATE POLICY tenant_isolation ON products
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Cache del retrieval por tenant (palanca de costo §40): la misma pregunta
-- no vuelve a pagar embedding. Se invalida al tocar cualquier fuente.
CREATE TABLE IF NOT EXISTS knowledge_query_cache (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  query_hash text NOT NULL,
  results    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, query_hash)
);
ALTER TABLE knowledge_query_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_query_cache FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'knowledge_query_cache') THEN
    CREATE POLICY tenant_isolation ON knowledge_query_cache
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
