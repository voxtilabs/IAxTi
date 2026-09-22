-- Quién creó cada actividad (#454).
--
-- `crm.create_activity` es una de las DOS herramientas que la ADR-0017 le
-- permite escribir al asistente, y hasta ahora una tarea suya y una escrita
-- por una persona eran indistinguibles en la tabla. En la pantalla de
-- pendientes eso importa: lo que anotó la IA se revisa distinto de lo que
-- se anotó uno mismo.
--
-- El libro de auditoría ya lo sabe —`agent.tool.crm.create_activity` con
-- actor_kind 'agent'— pero cruzarlo para pintar una lista sería pagar un
-- JOIN contra una tabla append-only en cada pantalla.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS created_by_kind text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activities_created_by_kind_ck') THEN
    ALTER TABLE activities ADD CONSTRAINT activities_created_by_kind_ck
      CHECK (created_by_kind IS NULL OR created_by_kind IN ('user','agent','system','apikey','soporte'));
  END IF;
END $$;

-- Lo de antes queda en NULL a propósito: no sabemos quién las creó y
-- rellenarlo con 'user' sería inventar. La pantalla lo trata como "sin dato".
