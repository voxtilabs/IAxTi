-- Evaluación (#53, SPEC §13): el dataset del tenant se alimenta del
-- feedback humano de la bandeja (anonimizado), y cada corrida queda como
-- run comparable — ninguna versión empeora sin que se note.
CREATE TABLE IF NOT EXISTS eval_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  agent_id      uuid REFERENCES agents(id),
  suggestion_id uuid UNIQUE, -- de dónde vino (una vez por sugerencia)
  task          text NOT NULL DEFAULT 'sugerir',
  contexto      text NOT NULL,     -- SIEMPRE anonimizado (redactPII)
  criterios     jsonb NOT NULL DEFAULT '[]'::jsonb,
  referencia    text,              -- la respuesta juzgada por el humano
  feedback      text CHECK (feedback IN ('up','down')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eval_cases_tenant_idx ON eval_cases (tenant_id, task);
ALTER TABLE eval_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_cases FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'eval_cases') THEN
    CREATE POLICY tenant_isolation ON eval_cases
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS eval_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  agent_id       uuid NOT NULL REFERENCES agents(id),
  task           text NOT NULL DEFAULT 'sugerir',
  provider       text NOT NULL,
  model          text NOT NULL,
  prompt_version text,
  case_count     int NOT NULL,
  scores         jsonb NOT NULL, -- por caso: {caseId, correctness, tono, tools, total, comentario}
  score          numeric(4,3) NOT NULL, -- promedio: el número del gate
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eval_runs_tenant_idx
  ON eval_runs (tenant_id, agent_id, created_at DESC);
ALTER TABLE eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_runs FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'eval_runs') THEN
    CREATE POLICY tenant_isolation ON eval_runs
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
