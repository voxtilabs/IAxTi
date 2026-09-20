-- #299: keyset estable por tenant, columna e id. No cambia filas ni RLS.
CREATE INDEX IF NOT EXISTS contacts_tenant_name_id_idx
  ON contacts (tenant_id, name, id) WHERE merged_into IS NULL;
CREATE INDEX IF NOT EXISTS contacts_tenant_activity_id_idx
  ON contacts (tenant_id, last_activity_at DESC, id DESC) WHERE merged_into IS NULL;
CREATE INDEX IF NOT EXISTS deals_tenant_created_id_idx ON deals (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS deals_tenant_title_id_idx ON deals (tenant_id, title, id);
CREATE INDEX IF NOT EXISTS deals_tenant_value_id_idx ON deals (tenant_id, value_clp, id);
