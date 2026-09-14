-- crm, quinta parte (#34): fusión de contactos. El duplicado NO se borra —
-- queda apuntando al principal (la historia es el activo) y ningún proceso
-- lo deshace automáticamente.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES contacts(id),
  ADD COLUMN IF NOT EXISTS merged_at   timestamptz;
CREATE INDEX IF NOT EXISTS contacts_merged_idx
  ON contacts (tenant_id, merged_into) WHERE merged_into IS NOT NULL;
