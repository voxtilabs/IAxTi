-- Secuencias (#63, SPEC §15): el seguimiento multi-paso que se corta
-- SOLO cuando el cliente responde o la oportunidad se mueve.
CREATE TABLE IF NOT EXISTS sequences (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  -- [{afterHours, onlyIfNoReply?, action:{kind,params}}] en orden
  steps      jsonb NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sequences_tenant_idx ON sequences (tenant_id);
ALTER TABLE sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequences FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sequences') THEN
    CREATE POLICY tenant_isolation ON sequences
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  sequence_id     uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  contact_id      uuid NOT NULL,
  deal_id         uuid,
  current_step    int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','completed','stopped')),
  stop_reason     text,
  next_run_at     timestamptz,
  enrolled_by     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Una inscripción viva por secuencia y conversación.
  UNIQUE (sequence_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS sequence_enrollments_due_idx
  ON sequence_enrollments (next_run_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS sequence_enrollments_contact_idx
  ON sequence_enrollments (tenant_id, contact_id);
ALTER TABLE sequence_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_enrollments FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sequence_enrollments') THEN
    CREATE POLICY tenant_isolation ON sequence_enrollments
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
