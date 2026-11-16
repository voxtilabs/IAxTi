-- Un webhook firmado pero de otra cuenta o de otro negocio también deja rastro (#1321).
--
-- Con Zernio la firma prueba que el evento viene de Zernio, no que sea de la
-- cuenta a la que apunta la URL: cada evento trae su cuenta, su perfil y el
-- `externalId` del perfil (el tenant), y el camino de entrada rechaza el que
-- no calza. Anotarlo como `firma_invalida` mandaría a cambiar un secreto que
-- está bien.
--
-- Ampliar el CHECK es aditivo: la versión anterior de la aplicación nunca
-- escribe el valor nuevo.
DO $$
BEGIN
  ALTER TABLE channel_accounts DROP CONSTRAINT IF EXISTS channel_accounts_last_webhook_result_ck;
  ALTER TABLE channel_accounts ADD CONSTRAINT channel_accounts_last_webhook_result_ck
    CHECK (last_webhook_result IS NULL OR last_webhook_result IN
      ('aceptado','firma_invalida','sin_secreto','cuenta_desconectada','sin_proveedor','conexion_sin_confirmar','perfil_ajeno'));
END $$;
