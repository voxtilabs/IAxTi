-- Tabla de plataforma: es la dueña de los tenants, por eso no lleva
-- tenant_id ni RLS de aislamiento (el acceso pasa por permisos platform.*).
-- Las entidades de negocio del módulo (PlanLimits, UsageMeter, Team) llegan
-- con el issue #8 en migraciones aditivas posteriores.
CREATE TABLE IF NOT EXISTS tenants (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
