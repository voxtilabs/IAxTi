-- Modo autónomo (#49, SPEC §13): el modo POR CONVERSACIÓN. Autónomo llega
-- solo por horario del tenant o por marca manual — JAMÁS por defecto.
CREATE TABLE IF NOT EXISTS agent_conversation_modes (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL,
  mode            text NOT NULL CHECK (mode IN ('assist','autonomous','off')),
  set_by          text NOT NULL, -- userId o 'system' (p. ej. al escalar)
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id)
);
ALTER TABLE agent_conversation_modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_conversation_modes FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'agent_conversation_modes') THEN
    CREATE POLICY tenant_isolation ON agent_conversation_modes
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
