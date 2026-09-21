-- El asistente que le responde al DUEÑO (#410).
--
-- La lista de objetivos vivía en dos lugares —el tipo de TypeScript y este
-- CHECK— y agregar uno solo arriba lo dejaba pasar por la validación de la
-- aplicación para morir en la base con un error de constraint, que el
-- usuario ve como "algo salió mal". Los dos lugares se sostienen: el CHECK
-- es lo que impide que una fila escrita por otro camino (un script, una
-- restauración) invente un objetivo que el código no sabe resolver.
--
-- 'estadisticas' es el primero cuyo destinatario NO es el cliente del
-- negocio sino su dueño: no contesta WhatsApp, contesta adentro del
-- producto y solo con herramientas de lectura.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_objetivo_ck') THEN
    ALTER TABLE agents DROP CONSTRAINT agents_objetivo_ck;
  END IF;
  ALTER TABLE agents ADD CONSTRAINT agents_objetivo_ck
    CHECK (objetivo IS NULL OR objetivo IN
      ('agendar','vender','informar','calificar','cobrar','estadisticas'));
END $$;
