-- #751: sobrevive al rollback de sources y a la muerte del proceso.
-- Sin FK a sources: la intención necesita sobrevivir a su DELETE y no debe
-- adquirir el candado de esa fila al registrarse antes de tocar R2.
CREATE TABLE pending_file_deletions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_id uuid NOT NULL,
  r2_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  PRIMARY KEY (tenant_id, source_id)
);
CREATE INDEX pending_file_deletions_age_idx ON pending_file_deletions(tenant_id, created_at);
ALTER TABLE pending_file_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_file_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pending_file_deletions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ADR-0026: solo ids ya visibles en tenants; el barrido trabaja bajo withTenant.
CREATE FUNCTION tenants_con_borrados_de_conocimiento(p_antes timestamptz)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT DISTINCT p.tenant_id FROM pending_file_deletions p WHERE p.created_at <= p_antes
$$;
REVOKE ALL ON FUNCTION tenants_con_borrados_de_conocimiento(timestamptz) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
    GRANT EXECUTE ON FUNCTION tenants_con_borrados_de_conocimiento(timestamptz) TO iaxti_app;
  END IF;
END $$;
