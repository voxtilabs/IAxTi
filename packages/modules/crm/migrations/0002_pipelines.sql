-- crm, segunda parte (SPEC §10): Pipeline, Stage y Deal con sus reglas.
-- La regla "una oportunidad abierta por contacto y pipeline" vive en un
-- índice único parcial: la base la garantiza aunque el código se equivoque.

CREATE TABLE IF NOT EXISTS pipelines (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  vertical   text, -- vertical de origen (servicios, inmobiliaria, …), opcional
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipelines FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'pipelines') THEN
    CREATE POLICY tenant_isolation ON pipelines
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS stages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  pipeline_id   uuid NOT NULL REFERENCES pipelines(id),
  name          text NOT NULL,
  position      int  NOT NULL, -- orden dentro del pipeline, 0-based
  type          text NOT NULL CHECK (type IN ('open','won','lost')),
  probability   int  CHECK (probability BETWEEN 0 AND 100),
  expected_days int  CHECK (expected_days >= 0), -- para detectar estancamiento
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, position)
);
CREATE INDEX IF NOT EXISTS stages_tenant_pipeline_idx ON stages (tenant_id, pipeline_id, position);
ALTER TABLE stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE stages FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'stages') THEN
    CREATE POLICY tenant_isolation ON stages
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Motivos de pérdida: lista configurable por tenant (SPEC §10).
CREATE TABLE IF NOT EXISTS loss_reasons (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  label      text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, label)
);
ALTER TABLE loss_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE loss_reasons FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'loss_reasons') THEN
    CREATE POLICY tenant_isolation ON loss_reasons
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS deals (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  contact_id             uuid NOT NULL REFERENCES contacts(id),
  pipeline_id            uuid NOT NULL REFERENCES pipelines(id),
  stage_id               uuid NOT NULL REFERENCES stages(id),
  title                  text NOT NULL,
  -- Valor: si la moneda es UF se guarda TAMBIÉN el valor en pesos al día
  -- y la UF usada, para que el número no cambie con la UF de mañana (SPEC §10).
  value                  numeric(14,2),
  currency               text NOT NULL DEFAULT 'CLP' CHECK (currency IN ('CLP','UF','USD')),
  value_clp              numeric(14,2),
  uf_rate                numeric(10,2),
  owner_id               uuid,
  expected_close_date    date,
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  lost_reason_id         uuid REFERENCES loss_reasons(id),
  source_conversation_id uuid, -- conversación de origen; FK cuando exista el módulo
  stage_entered_at       timestamptz NOT NULL DEFAULT now(),
  stalled                boolean NOT NULL DEFAULT false,
  won_at                 timestamptz,
  lost_at                timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
-- Un contacto tiene a lo más UNA oportunidad abierta por pipeline (SPEC §10).
CREATE UNIQUE INDEX IF NOT EXISTS deals_one_open_per_contact_pipeline
  ON deals (tenant_id, contact_id, pipeline_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS deals_tenant_status_idx ON deals (tenant_id, status);
CREATE INDEX IF NOT EXISTS deals_tenant_owner_idx ON deals (tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS deals_tenant_stage_idx ON deals (tenant_id, stage_id);
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'deals') THEN
    CREATE POLICY tenant_isolation ON deals
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Historia de etapas: cada movimiento con su motivo cuando lo hubo.
-- Alimenta la ficha (#32) y la auditoría de retrocesos.
CREATE TABLE IF NOT EXISTS deal_stage_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  deal_id       uuid NOT NULL REFERENCES deals(id),
  from_stage_id uuid REFERENCES stages(id),
  to_stage_id   uuid NOT NULL REFERENCES stages(id),
  reason        text,
  actor         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deal_stage_history_deal_idx ON deal_stage_history (tenant_id, deal_id, created_at);
ALTER TABLE deal_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_stage_history FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'deal_stage_history') THEN
    CREATE POLICY tenant_isolation ON deal_stage_history
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
