-- El rastro del último webhook de cada cuenta (#434).
--
-- Cuando un mensaje no llega a la bandeja, el producto no tenía nada que
-- decir: no guardaba si había llegado un webhook, ni cuándo, ni si la firma
-- calzó. Y «no llegó ninguno» y «llegaron pero la firma no calza» son
-- problemas distintos con arreglos distintos.
--
-- NO se guarda el cuerpo ni la firma: el cuerpo trae el mensaje de una
-- persona y la firma es material de un secreto. Lo que se guarda es cuándo
-- y cómo terminó.
ALTER TABLE channel_accounts
  ADD COLUMN IF NOT EXISTS last_webhook_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_webhook_result text,
  -- Cuándo fue la última vez que uno entró BIEN. Se conserva aparte del
  -- anterior: si empiezan a fallar, sigue sirviendo saber desde cuándo.
  ADD COLUMN IF NOT EXISTS last_webhook_ok_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channel_accounts_last_webhook_result_ck') THEN
    ALTER TABLE channel_accounts ADD CONSTRAINT channel_accounts_last_webhook_result_ck
      CHECK (last_webhook_result IS NULL OR last_webhook_result IN
        ('aceptado','firma_invalida','sin_secreto','cuenta_desconectada','sin_proveedor'));
  END IF;
END $$;
