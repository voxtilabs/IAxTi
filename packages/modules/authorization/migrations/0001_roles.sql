-- Roles como paquetes de permisos (SPEC §27, ADR-0008).
-- Los base son globales (tenant_id NULL) e inmutables desde la app; los
-- custom (v2, issue #73) nacen clonando un base dentro del tenant.
CREATE TABLE IF NOT EXISTS roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid REFERENCES tenants(id),
  name       text NOT NULL,
  base       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_base_name_idx ON roles (name) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS roles_tenant_name_idx ON roles (tenant_id, name) WHERE tenant_id IS NOT NULL;

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'roles') THEN
    -- Los base (tenant_id NULL) se leen desde cualquier tenant; escribir
    -- exige tenant propio: la app jamás crea ni edita roles base.
    CREATE POLICY roles_visibles ON roles
      USING (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

INSERT INTO roles (tenant_id, name, base) VALUES
  (NULL, 'SUPERADMIN', true),
  (NULL, 'ADMIN', true),
  (NULL, 'SUPERVISOR', true),
  (NULL, 'USER', true)
ON CONFLICT DO NOTHING;

-- Un usuario tiene UN rol por tenant (SPEC §9). Los user_id vienen de
-- Supabase Auth (#7); el tipo uuid es el mismo.
CREATE TABLE IF NOT EXISTS user_roles (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL,
  role_id    uuid NOT NULL REFERENCES roles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_roles') THEN
    CREATE POLICY tenant_isolation ON user_roles
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- ApiKey: SOLO esquema por ahora (SPEC §9 la marca v2; endpoints en #24).
-- El token jamás se guarda: solo su hash.
CREATE TABLE IF NOT EXISTS api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  scopes       jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'api_keys') THEN
    CREATE POLICY tenant_isolation ON api_keys
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
