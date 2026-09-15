-- Idempotency-Key (SPEC §28): la cabecera estaba documentada en el OpenAPI y
-- permitida por CORS, pero no la leía nadie. Un POST reintentado —una red
-- que se corta, un botón apretado dos veces— creaba el trato dos veces y
-- cobraba dos veces.
--
-- La respuesta se guarda TAL CUAL se devolvió: un reintento con la misma
-- llave recibe exactamente lo mismo, no una segunda ejecución.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  key             text NOT NULL,
  method          text NOT NULL,
  path            text NOT NULL,
  -- Huella del cuerpo: la misma llave con otro cuerpo es un error del
  -- cliente, no un reintento.
  request_hash    text NOT NULL,
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_limpieza_idx ON idempotency_keys (created_at);
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'idempotency_keys') THEN
    CREATE POLICY tenant_isolation ON idempotency_keys
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
