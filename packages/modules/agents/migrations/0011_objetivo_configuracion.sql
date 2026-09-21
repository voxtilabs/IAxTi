-- El asistente de configuración, elegible como los demás (#415).
--
-- Mismo motivo que la 0010: la lista de objetivos vive en el tipo y en este
-- CHECK, y agregar uno solo arriba lo deja pasar la validación para morir en
-- la base con un error de constraint.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_objetivo_ck') THEN
    ALTER TABLE agents DROP CONSTRAINT agents_objetivo_ck;
  END IF;
  ALTER TABLE agents ADD CONSTRAINT agents_objetivo_ck
    CHECK (objetivo IS NULL OR objetivo IN
      ('agendar','vender','informar','calificar','cobrar','estadisticas','configuracion'));
END $$;
