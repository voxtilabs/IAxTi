-- Ciclo de vida del tenant, planes y medidores (SPEC §9 organizations, §6).
-- Aditiva sobre 0001_tenants.sql.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS rubro            text,
  ADD COLUMN IF NOT EXISTS timezone         text        NOT NULL DEFAULT 'America/Santiago',
  ADD COLUMN IF NOT EXISTS plan             text        NOT NULL DEFAULT 'base',
  ADD COLUMN IF NOT EXISTS state            text        NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS onboarding_state text        NOT NULL DEFAULT 'registered',
  ADD COLUMN IF NOT EXISTS trial_ends_at    timestamptz,
  ADD COLUMN IF NOT EXISTS settings         jsonb       NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_state_check') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_state_check
      CHECK (state IN ('trial','active','past_due','read_only','suspended','deleted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_onboarding_check') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_onboarding_check
      CHECK (onboarding_state IN ('registered','configured','whatsapp_connected','knowledge_added','team_invited','first_message','active'));
  END IF;
END $$;

-- Planes: tabla de plataforma (sin tenant_id); los valores se editan desde el
-- SuperAdmin sin desplegar (SPEC §22). retention_months y api_requests_month
-- según SPEC §39 y la cuota de API por tenant (issues #25/#77).
CREATE TABLE IF NOT EXISTS plan_limits (
  plan               text PRIMARY KEY,
  whatsapp_numbers   int  NOT NULL,
  conversations_month int NOT NULL,
  ia_executions_month int NOT NULL,
  retention_months   int,
  api_requests_month int,
  modules            jsonb NOT NULL DEFAULT '[]'::jsonb
);

INSERT INTO plan_limits (plan, whatsapp_numbers, conversations_month, ia_executions_month, retention_months, api_requests_month, modules) VALUES
  ('base',   1, 500,  1000, 12,  NULL, '["crm","conversations","agents","calendar","payments"]'),
  ('crece',  2, 2000, 4000, 24,  NULL, '["crm","conversations","agents","calendar","payments","automations","knowledge","integrations"]'),
  ('equipo', 5, 8000, 12000, NULL, NULL, '["crm","conversations","agents","calendar","payments","automations","knowledge","integrations","analytics"]')
ON CONFLICT (plan) DO NOTHING;

-- Equipos para asignación (SPEC §9): de negocio → tenant_id + RLS.
CREATE TABLE IF NOT EXISTS teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS teams_tenant_idx ON teams (tenant_id);
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'teams') THEN
    CREATE POLICY tenant_isolation ON teams
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Medidores de uso por ciclo (SPEC §9): se actualizan por evento y se
-- consolidan cada hora; period_start es el inicio del ciclo mensual.
CREATE TABLE IF NOT EXISTS usage_meters (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  metric       text NOT NULL,
  period_start date NOT NULL,
  value        bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, period_start)
);
ALTER TABLE usage_meters ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_meters FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'usage_meters') THEN
    CREATE POLICY tenant_isolation ON usage_meters
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
