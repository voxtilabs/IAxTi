-- automations (#62, SPEC §15): reglas y sus corridas. Cada corrida queda
-- con dedupe_key — la misma regla no dispara dos veces por el mismo
-- evento/objeto/día, ni con varios workers a la vez.
CREATE TABLE IF NOT EXISTS rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         text NOT NULL,
  trigger      jsonb NOT NULL,  -- {kind:'event',event} | {kind:'time',time:{base,hours,stageName?}}
  conditions   jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{field,op,value}]
  actions      jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{kind,params}]
  active       boolean NOT NULL DEFAULT false,     -- nace apagada: preview primero
  pause_reason text,             -- pausada con aviso (módulo apagado), no rota
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rules_tenant_idx ON rules (tenant_id, active);
ALTER TABLE rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE rules FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rules') THEN
    CREATE POLICY tenant_isolation ON rules
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS rule_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  rule_id     uuid NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  object_kind text NOT NULL, -- conversation | deal | contact
  object_id   uuid NOT NULL,
  dedupe_key  text NOT NULL UNIQUE, -- rule:objeto:evento-o-día
  status      text NOT NULL CHECK (status IN ('ok','failed','skipped','deferred')),
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rule_runs_tenant_idx ON rule_runs (tenant_id, rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rule_runs_object_idx ON rule_runs (tenant_id, rule_id, object_id) WHERE status = 'failed';
ALTER TABLE rule_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_runs FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rule_runs') THEN
    CREATE POLICY tenant_isolation ON rule_runs
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
