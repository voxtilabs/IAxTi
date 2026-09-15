-- La cancelación en un clic (SPEC §6, issue de la cancelación).
--
-- «Cancelación en un clic desde la app, con exportación completa antes.» No
-- existía ninguna de las dos cosas; la exportación llegó en #222 y esto es
-- la otra mitad.
--
-- Cancelar NO corta el servicio en el acto: el negocio pagó su ciclo y lo
-- usa hasta el final. `cancel_at` es esa fecha, y el barrido diario la mira.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS cancel_at date,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason text;

COMMENT ON COLUMN subscriptions.cancel_at IS
  'Fin del ciclo pagado: hasta acá el servicio sigue igual (SPEC §6).';
