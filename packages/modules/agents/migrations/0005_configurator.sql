-- El configurador (#50, SPEC §13): la propuesta vive como DIFF pendiente
-- hasta que el USUARIO la aplica — el agente propone, jamás actúa solo.
CREATE TABLE IF NOT EXISTS agent_proposals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  agent_id     uuid REFERENCES agents(id),
  execution_id uuid REFERENCES agent_executions(id),
  description  text NOT NULL, -- lo que el dueño contó de su negocio
  vertical     text NOT NULL DEFAULT 'otro',
  proposal     jsonb NOT NULL, -- lo que el modelo propuso (parseado)
  diff         jsonb NOT NULL, -- antes/después contra lo que YA existe
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed')),
  applied_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_proposals_tenant_idx
  ON agent_proposals (tenant_id, created_at DESC);
ALTER TABLE agent_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_proposals FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'agent_proposals') THEN
    CREATE POLICY tenant_isolation ON agent_proposals
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
