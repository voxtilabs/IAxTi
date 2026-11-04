-- Por qué no salió el recordatorio (#1250).
--
-- `marcarAvisoEnviado` consume el aviso y pasa la cita a `reminded` ANTES de
-- intentar el envío —a propósito: el orden inverso manda el mensaje tres veces
-- cuando dos barridos se cruzan—. Pero si el envío después falla, el motivo se
-- perdía: `tick` solo lo contaba (`saltados += 1`) y la pantalla seguía
-- diciendo «Avisada». El dueño veía una cita avisada a la que nunca le llegó
-- nada.
--
-- Aditiva, como manda la regla: dos columnas que nacen nulas. Las citas que ya
-- existen no cambian de comportamiento.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS aviso_error text;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS aviso_error_at timestamptz;

-- Para la pantalla: «las citas de este negocio a las que les falló el aviso».
-- Empieza por tenant_id como toda tabla de negocio, y es parcial porque lo
-- normal es que esté vacía.
CREATE INDEX IF NOT EXISTS appointments_aviso_error_idx
  ON appointments (tenant_id, aviso_error_at DESC)
  WHERE aviso_error IS NOT NULL;
