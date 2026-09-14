-- Administradores de plataforma (SPEC §22): el SUPERADMIN es cross-tenant,
-- así que no vive en user_roles (que exige tenant). Sin RLS: esta tabla la
-- consulta solo la conexión de servicio de la API y jamás se expone.
CREATE TABLE IF NOT EXISTS platform_admins (
  user_id    uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
