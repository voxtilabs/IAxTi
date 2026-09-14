-- Webhooks salientes (#76, SPEC §24): suscripciones por tenant a eventos
-- del catálogo, y cada entrega con su historia completa.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  url             text NOT NULL,
  events          jsonb NOT NULL DEFAULT '[]'::jsonb, -- nombres del catálogo
  -- El secreto DE FIRMA de NUESTRAS entregas (whsec_…): se genera acá,
  -- el cliente lo guarda para verificar. Rotable.
  secret          text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  failing_since   timestamptz,
  disabled_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_tenant_idx ON webhook_endpoints (tenant_id);
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'webhook_endpoints') THEN
    CREATE POLICY tenant_isolation ON webhook_endpoints
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  endpoint_id     uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id        bigint NOT NULL, -- id del outbox: rastreable
  event_name      text NOT NULL,
  payload         jsonb NOT NULL,
  attempt         int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','ok','failed')),
  response_status int,
  response_body   text, -- truncado: para diagnosticar, no para archivar
  next_retry_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Un evento entra UNA vez por endpoint (el consumer es idempotente).
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
  ON webhook_deliveries (next_retry_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_deliveries_tenant_idx
  ON webhook_deliveries (tenant_id, created_at DESC);
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'webhook_deliveries') THEN
    CREATE POLICY tenant_isolation ON webhook_deliveries
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
