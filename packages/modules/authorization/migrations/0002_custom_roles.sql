-- Roles personalizados (#73): el custom clona un base y edita su set de
-- permisos desde el catálogo. Los base siguen inmutables (base = true y
-- tenant_id NULL; la política de RLS ya impide escribirlos).
ALTER TABLE roles ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS cloned_from text;
