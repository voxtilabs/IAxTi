-- #74: Instagram y Messenger entran a la MISMA bandeja. El canal de la
-- conversación es lo único que cambia; estados, SLA, resumen y asignación son
-- los mismos. El CHECK se amplía, no se reemplaza.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check
  CHECK (channel IN ('whatsapp','webchat','simulador','instagram','messenger'));
