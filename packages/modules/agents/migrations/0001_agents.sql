-- agents (#47, SPEC §13): Agent y Execution. El proveedor/modelo vive en
-- CONFIGURACIÓN (por agente y por tarea): cambiar de modelo no es deploy.
CREATE TABLE IF NOT EXISTS agents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  name                   text NOT NULL, -- el nombre que ve el cliente final
  personality            text,
  language               text NOT NULL DEFAULT 'es-CL',
  provider               text NOT NULL DEFAULT 'google',   -- google | anthropic | glm | …
  model                  text NOT NULL DEFAULT 'gemini-2.5-flash',
  prompt_name            text,          -- prompt versionado en Langfuse
  prompt_version         text,
  fallback_system_prompt text,          -- configurable, jamás hardcodeado
  allowed_tools          jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_mode           text NOT NULL DEFAULT 'assist' CHECK (default_mode IN ('assist','autonomous','off')),
  autonomous_hours       jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits                 jsonb NOT NULL DEFAULT '{}'::jsonb, -- max_executions_day, …
  active                 boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agents_tenant_idx ON agents (tenant_id);
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'agents') THEN
    CREATE POLICY tenant_isolation ON agents
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Cada corrida queda con TODO: entrada, decisión, tools, salida, tokens,
-- costo, latencia, trace de Langfuse y la explicación legible (SPEC §13).
CREATE TABLE IF NOT EXISTS agent_executions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  agent_id     uuid REFERENCES agents(id),
  task         text NOT NULL, -- clasificar | sugerir | configurar | conocer | …
  provider     text NOT NULL,
  model        text NOT NULL,
  input        jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision     text,
  tools_called jsonb NOT NULL DEFAULT '[]'::jsonb,
  output       jsonb,
  tokens_in    int,
  tokens_out   int,
  cost_usd     numeric(10,6),
  latency_ms   int,
  trace_id     text, -- el MISMO desde el request hasta la generación
  explanation  text, -- "por qué hice esto", legible para el equipo
  status       text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','failed')),
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_executions_tenant_idx
  ON agent_executions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_executions_agent_idx
  ON agent_executions (tenant_id, agent_id, created_at DESC);
ALTER TABLE agent_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_executions FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'agent_executions') THEN
    CREATE POLICY tenant_isolation ON agent_executions
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
