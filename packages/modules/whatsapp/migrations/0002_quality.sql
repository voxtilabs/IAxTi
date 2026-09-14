-- Calidad del número (#45): la pausa de envíos del negocio es EXPLÍCITA y
-- solo el ADMIN la levanta — volver a green no dispara nada solo.
ALTER TABLE whatsapp_numbers
  ADD COLUMN IF NOT EXISTS business_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS paused_reason      text;
