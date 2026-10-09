-- La agenda guarda el evento de Google y el motivo de cancelación, y ninguna
-- consulta los devuelve (#700).
--
-- `cancel_reason` se escribe en cada cancelación desde el primer día: nadie
-- podía contestar «¿por qué se nos cancelan las visitas?», que para una
-- inmobiliaria es la pregunta del mes.
--
-- `google_event_id` es la otra mitad de la sincronización con Google. Hoy NADIE
-- la escribe —la conexión con Google es #57 y no existe todavía— así que el
-- issue se equivoca al decir que «algo la escribe». Lo que se puede construir
-- ahora, y es lo que importa, es que el día que #57 llegue cancelar acá no deje
-- el evento vivo allá ocupando la hora: el camino de cancelación la lee y, si
-- no se pudo avisar a Google, lo DICE en vez de callarse.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS google_sync_error text;

-- Para agrupar los motivos del mes sin recorrer la agenda entera.
CREATE INDEX IF NOT EXISTS appointments_canceladas_idx
  ON appointments (tenant_id, starts_at DESC)
  WHERE status = 'cancelled';

-- Y para encontrar las que quedaron desincronizadas con Google.
CREATE INDEX IF NOT EXISTS appointments_google_pendiente_idx
  ON appointments (tenant_id, starts_at)
  WHERE google_sync_error IS NOT NULL;
