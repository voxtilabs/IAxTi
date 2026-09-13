-- audit_log: append-only, hash encadenado por tenant (SPEC §13, ADR-0008).
-- La inmutabilidad se impone con un trigger que aplica a TODOS los roles
-- (portable a Supabase, donde no controlamos qué rol corre la app);
-- los GRANT del rol de aplicación además omiten UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid        NOT NULL REFERENCES tenants(id),
  actor       text        NOT NULL,
  actor_kind  text        NOT NULL CHECK (actor_kind IN ('user','agent','system','superadmin','apikey')),
  action      text        NOT NULL,
  resource    text        NOT NULL,
  resource_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  ip          inet,
  user_agent  text,
  result      text        NOT NULL,
  request_id  text,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  prev_hash   text,
  hash        text        NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_tenant_time_idx
  ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_tenant_action_idx
  ON audit_log (tenant_id, action);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'audit_log') THEN
    CREATE POLICY tenant_isolation ON audit_log
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION audit_log_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es append-only: % no está permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log;
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_inmutable();
