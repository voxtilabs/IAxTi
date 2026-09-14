-- Gestión de tenants del SuperAdmin (#68): prueba extendible y el modo
-- soporte CON AVISO — ayudar sin violar la confianza (SPEC §22).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

CREATE TABLE IF NOT EXISTS platform_support_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  admin_user uuid NOT NULL,
  reason     text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ends_at    timestamptz NOT NULL,
  ended_at   timestamptz
);
CREATE INDEX IF NOT EXISTS support_sessions_tenant_idx
  ON platform_support_sessions (tenant_id, ends_at DESC);
-- Sin RLS: tabla DE plataforma — la escribe el SuperAdmin y la lee el
-- aviso del tenant, siempre por caso de uso.
