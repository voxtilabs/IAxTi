-- El reintento del registro conserva el negocio inicial aun si después
-- aparece otra membresía. Es una referencia, nunca concede acceso (#56).
CREATE TABLE initial_business_registrations (
  user_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX initial_business_registrations_tenant_idx
  ON initial_business_registrations(tenant_id);
ALTER TABLE initial_business_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE initial_business_registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY registro_del_tenant ON initial_business_registrations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY registro_de_la_sesion ON initial_business_registrations FOR SELECT
  USING (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
