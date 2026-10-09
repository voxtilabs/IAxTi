-- Desconectar un número sin perder lo que pasó por él (#600).
--
-- No había forma de desconectar un canal desde el producto. El cupo del plan se
-- cuenta sobre las filas de `whatsapp_numbers`, así que un número que ya no
-- sirve —porque la llave cambió de proyecto y su emisor no existe allá— seguía
-- ocupando lugar, y la única salida era entrar a la base a mano.
--
-- Se ARCHIVA, no se borra: las conversaciones cuelgan de la cuenta de canal y
-- borrar la fila del número dejaría el historial sin de dónde salió. Es la misma
-- regla que el resto del producto (SPEC §39): nada se borra desde la interfaz.
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;

-- El único de `sender_id` ahora ignora los desconectados.
--
-- Sin esto, desconectar un número y volver a conectar el MISMO después —el caso
-- normal: se desconecta para reapuntar y algo sale mal— choca contra el único y
-- sale «Ese número ya está conectado en IAxTi.», que es exactamente el mensaje
-- equivocado: no está conectado, está archivado. Un índice que impide
-- reconectar lo que uno mismo desconectó no está cuidando nada.
--
-- Es una RELAJACIÓN —acepta todo lo que aceptaba antes y un caso más— así que la
-- versión anterior de la app funciona con este esquema.
DROP INDEX IF EXISTS whatsapp_numbers_sender_idx;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_numbers_sender_idx
  ON whatsapp_numbers (sender_id)
  WHERE sender_id IS NOT NULL AND disconnected_at IS NULL;

-- Y el mismo trato para `phone_number_id`.
--
-- Lo cazó la prueba de reconexión: el único de `sender_id` ya ignoraba los
-- archivados y la reconexión seguía fallando, ahora contra
-- `whatsapp_numbers_phone_number_id_key`. Es el mismo defecto con otro nombre —
-- y la misma lección de #748: arreglar un índice único cuando hay otro encima
-- solo cambia cuál es el que lanza.
--
-- Este nace como CONSTRAINT en 0001 (`UNIQUE (phone_number_id)`), así que se
-- saca con ALTER TABLE y no con DROP INDEX, y se reemplaza por un único parcial.
ALTER TABLE whatsapp_numbers DROP CONSTRAINT IF EXISTS whatsapp_numbers_phone_number_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_numbers_phone_idx
  ON whatsapp_numbers (phone_number_id)
  WHERE disconnected_at IS NULL;
