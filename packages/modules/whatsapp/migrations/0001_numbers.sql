-- whatsapp (#42): los ids de Meta viven en NUESTRA base desde el día uno —
-- migrar de Kapso a Tech Provider propio no pierde nada. El número es del
-- cliente; cuántos, lo dice su plan (se valida en aplicación).
CREATE TABLE IF NOT EXISTS whatsapp_numbers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id),
  phone_number_id    text NOT NULL, -- id de Meta del número
  waba_id            text,          -- WhatsApp Business Account de Meta
  display_phone      text,          -- +56 9 …, solo para mostrar
  quality            text CHECK (quality IN ('green','yellow','red')),
  messaging_limit    text,          -- TIER_250, TIER_1K, … tal cual Meta
  connected_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (phone_number_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_numbers_tenant_idx ON whatsapp_numbers (tenant_id);
ALTER TABLE whatsapp_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_numbers FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'whatsapp_numbers') THEN
    CREATE POLICY tenant_isolation ON whatsapp_numbers
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
