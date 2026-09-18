-- Empresas (SPEC §10, issue 248). La tabla nació en 0001 y nadie la escribía
-- nunca. Esto le agrega lo que le faltaba para usarse de verdad:
--
-- - `archived_at`: nada se borra desde la interfaz (regla de negocio). Una
--   empresa borrada de golpe dejaría contactos apuntando a un fantasma.
-- - unicidad de RUT por tenant: el RUT identifica a la empresa en Chile, y
--   dos fichas del mismo RUT son el mismo problema que dos contactos con el
--   mismo teléfono. Parcial, porque el RUT es opcional.
-- - `updated_at`, que ya tienen contactos y oportunidades.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS companies_tenant_rut_idx
  ON companies (tenant_id, rut) WHERE rut IS NOT NULL AND archived_at IS NULL;

-- El listado ordena por nombre dentro del tenant y esconde las archivadas.
CREATE INDEX IF NOT EXISTS companies_tenant_activas_idx
  ON companies (tenant_id, name) WHERE archived_at IS NULL;

-- Buscar el contacto por su empresa es la consulta de la ficha.
CREATE INDEX IF NOT EXISTS contacts_tenant_company_idx
  ON contacts (tenant_id, company_id) WHERE company_id IS NOT NULL;
