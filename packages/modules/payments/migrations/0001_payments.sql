-- payments (#60/#61, SPEC §17): proveedores con credenciales POR
-- REFERENCIA, links con máquina de estados, y el Payment confirmado.
CREATE TABLE IF NOT EXISTS payment_providers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  kind               text NOT NULL CHECK (kind IN ('flow','webpay','mercadopago','simulado')),
  name               text NOT NULL,
  -- Nombre de la env var con las credenciales — NUNCA la credencial.
  credential_ref     text NOT NULL,
  webhook_secret_ref text,
  mode               text NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_providers_tenant_idx ON payment_providers (tenant_id);
ALTER TABLE payment_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_providers FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'payment_providers') THEN
    CREATE POLICY tenant_isolation ON payment_providers
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS payment_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  provider_id     uuid NOT NULL REFERENCES payment_providers(id),
  contact_id      uuid NOT NULL,
  conversation_id uuid,
  deal_id         uuid,
  amount_clp      numeric(14,0) NOT NULL CHECK (amount_clp > 0),
  currency        text NOT NULL DEFAULT 'CLP',
  concept         text NOT NULL,
  external_id     text, -- el id de la orden en el proveedor
  url             text, -- el link que paga el cliente
  status          text NOT NULL DEFAULT 'created'
                  CHECK (status IN ('created','sent','paid','expired','cancelled')),
  expires_at      timestamptz,
  paid_at         timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_links_tenant_idx ON payment_links (tenant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payment_links_external_idx
  ON payment_links (tenant_id, provider_id, external_id) WHERE external_id IS NOT NULL;
ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_links FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'payment_links') THEN
    CREATE POLICY tenant_isolation ON payment_links
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Un link PAGADO es inmutable (SPEC §17): ni el estado ni el monto se
-- tocan después — el mismo patrón del audit_log.
CREATE OR REPLACE FUNCTION payment_links_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'paid' THEN
    RAISE EXCEPTION 'Un link pagado es inmutable.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payment_links_immutable_trg ON payment_links;
CREATE TRIGGER payment_links_immutable_trg
  BEFORE UPDATE OR DELETE ON payment_links
  FOR EACH ROW EXECUTE FUNCTION payment_links_immutable();

-- La confirmación (#61): el Payment con todo lo que llegó del proveedor.
CREATE TABLE IF NOT EXISTS payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  link_id             uuid NOT NULL REFERENCES payment_links(id),
  amount_clp          numeric(14,0) NOT NULL,
  method              text,
  provider_payment_id text,
  receipt_url         text,
  paid_at             timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Idempotencia del webhook: el mismo pago no entra dos veces.
  UNIQUE (tenant_id, link_id)
);
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'payments') THEN
    CREATE POLICY tenant_isolation ON payments
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
