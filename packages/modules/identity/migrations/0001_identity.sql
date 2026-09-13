-- Identidad (SPEC §9): el login vive en Supabase Auth (auth.users, GoTrue);
-- aquí viven el perfil y las invitaciones. user_id es el uuid de auth.users.

-- Perfil global del usuario (un usuario puede pertenecer a varios tenants,
-- por eso el perfil no lleva tenant_id; la pertenencia es user_roles).
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id    uuid PRIMARY KEY,
  name       text,
  phone      text,
  locale     text NOT NULL DEFAULT 'es-CL',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Invitación: tenant, email o teléfono, rol, expira en 7 días (SPEC §9).
CREATE TABLE IF NOT EXISTS invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  email       text,
  phone       text,
  role_name   text NOT NULL,
  token       text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS invitations_tenant_idx ON invitations (tenant_id);
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invitations') THEN
    CREATE POLICY tenant_isolation ON invitations
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
