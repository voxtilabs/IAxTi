-- crm, tercera parte (SPEC §10, #32): Activity — llamada, reunión, tarea o
-- nota, con vencimiento y responsable. El aviso de vencida (activity.due)
-- se publica UNA vez (due_notified_at) por el barrido programado.
CREATE TABLE IF NOT EXISTS activities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  contact_id       uuid NOT NULL REFERENCES contacts(id),
  deal_id          uuid REFERENCES deals(id),
  type             text NOT NULL CHECK (type IN ('llamada','reunion','tarea','nota')),
  title            text NOT NULL,
  body             text,
  owner_id         uuid, -- responsable
  due_at           timestamptz,
  due_notified_at  timestamptz,
  done_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activities_contact_idx
  ON activities (tenant_id, contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activities_due_idx
  ON activities (tenant_id, due_at)
  WHERE done_at IS NULL AND due_notified_at IS NULL AND due_at IS NOT NULL;
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'activities') THEN
    CREATE POLICY tenant_isolation ON activities
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
