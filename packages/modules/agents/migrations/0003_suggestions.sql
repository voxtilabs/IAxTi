-- El copiloto en assist (#48): cada entrante genera una Suggestion con
-- confianza y expiración. El humano manda: enviar es UN toque, y el
-- feedback alimenta el dataset de evaluación (#53).
CREATE TABLE IF NOT EXISTS suggestions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  agent_id        uuid REFERENCES agents(id),
  conversation_id uuid NOT NULL,
  message_id      uuid, -- el entrante que la gatilló
  execution_id    uuid REFERENCES agent_executions(id),
  text            text NOT NULL,
  confidence      numeric(3,2), -- 0.00–1.00
  intent          text,         -- cotizar | agendar | reclamo | consulta | otro
  lead_score      text CHECK (lead_score IN ('frio','tibio','caliente')),
  suggest_deal    boolean NOT NULL DEFAULT false, -- "¿creo la oportunidad?"
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','dismissed','expired')),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  feedback        text CHECK (feedback IN ('up','down')),
  feedback_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suggestions_conversation_idx
  ON suggestions (tenant_id, conversation_id, created_at DESC);
ALTER TABLE suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE suggestions FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'suggestions') THEN
    CREATE POLICY tenant_isolation ON suggestions
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
