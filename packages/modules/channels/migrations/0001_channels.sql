-- channels (#41, SPEC §12): la cuenta de canal. Las credenciales JAMÁS en
-- claro: credential_ref y webhook_secret_ref nombran el secreto (variable
-- de entorno o gestor) que el runtime resuelve.
CREATE TABLE IF NOT EXISTS channel_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  kind               text NOT NULL
                     CHECK (kind IN ('whatsapp','webchat','instagram','messenger','simulador')),
  name               text NOT NULL,
  state              text NOT NULL DEFAULT 'connecting'
                     CHECK (state IN ('connecting','active','degraded','disconnected')),
  credential_ref     text,
  webhook_secret_ref text,
  config             jsonb NOT NULL DEFAULT '{}'::jsonb, -- ids públicos, nunca secretos
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channel_accounts_tenant_idx ON channel_accounts (tenant_id, kind);
ALTER TABLE channel_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_accounts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'channel_accounts') THEN
    CREATE POLICY tenant_isolation ON channel_accounts
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
