-- Resumen rodante (#48, §40 palanca de costo nº 1): el contexto de la IA
-- son los últimos N mensajes + este resumen del resto — nunca el hilo
-- completo. summary_seq marca hasta qué mensaje quedó resumido.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS summary     text,
  ADD COLUMN IF NOT EXISTS summary_seq bigint;
