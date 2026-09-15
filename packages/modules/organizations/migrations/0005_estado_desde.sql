-- ¿Desde cuándo está el tenant en el estado en que está? (SPEC §6)
--
-- La máquina de estados manda plazos —30 días en solo lectura antes de
-- suspender, 90 suspendido antes de borrar— y en ninguna parte se guardaba
-- CUÁNDO entró a su estado actual. Sin eso, los plazos no se pueden contar.
--
-- Los tenants que ya existen arrancan el reloj ahora: nadie se suspende por
-- un tiempo que nunca se midió.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS state_since timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN tenants.state_since IS
  'Cuándo entró el tenant a su estado actual; los plazos de §6 se cuentan desde acá.';
