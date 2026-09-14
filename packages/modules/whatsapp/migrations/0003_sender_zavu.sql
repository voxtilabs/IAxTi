-- #42 (ADR-0014): el canal entra por Zavu y el identificador operativo pasa a
-- ser su `sender_id`. Los ids de Meta se conservan —el día del proveedor
-- propio (#82) sirven— pero dejan de ser obligatorios, porque Zavu no los
-- expone. La columna nueva es aditiva: ninguna fila existente se rompe.
ALTER TABLE whatsapp_numbers
  ADD COLUMN IF NOT EXISTS sender_id text;

ALTER TABLE whatsapp_numbers
  ALTER COLUMN phone_number_id DROP NOT NULL;

-- Un sender es un número: el UNIQUE evita conectar dos veces lo mismo. El
-- índice es parcial porque las filas viejas (de Meta directo) no tienen sender.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_numbers_sender_idx
  ON whatsapp_numbers (sender_id) WHERE sender_id IS NOT NULL;
