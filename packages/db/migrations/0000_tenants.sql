-- La tabla raíz del multi-tenancy es de PLATAFORMA: todos los módulos la
-- referencian por FK y las migraciones de plataforma corren antes que las de
-- cualquier módulo (identity va topológicamente antes que organizations y
-- aun así necesita tenants — CI con base vacía lo demostró).
-- organizations/0001 conserva su CREATE IF NOT EXISTS por compatibilidad con
-- bases ya migradas; aquí queda la fuente para bases nuevas.
CREATE TABLE IF NOT EXISTS tenants (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
