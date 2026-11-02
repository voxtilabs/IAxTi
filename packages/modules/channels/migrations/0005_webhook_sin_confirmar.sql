-- Un webhook rechazado por conexión a medio confirmar también deja rastro (#1180).
--
-- `webhooks.controller.ts` devolvía 503 a los canales en `connecting` ANTES de
-- cualquier `anotarWebhook`, así que un canal a medio conectar rechazaba cada
-- webhook sin dejar huella. El diagnóstico veía el rastro vacío y decía «nunca
-- llegó un webhook a esta cuenta», y mandaba a cambiar la URL en el panel del
-- proveedor — una configuración que estaba bien.
--
-- Medido el 02-11: cinco mensajes entre 00:13 y 03:13 están en el proveedor
-- como `inbound delivered` y ninguno dejó rastro acá.
--
-- Ampliar el CHECK es aditivo: nada de lo que ya era válido deja de serlo, y la
-- versión anterior de la aplicación sigue funcionando con este esquema — nunca
-- escribe el valor nuevo.
DO $$
BEGIN
  ALTER TABLE channel_accounts DROP CONSTRAINT IF EXISTS channel_accounts_last_webhook_result_ck;
  ALTER TABLE channel_accounts ADD CONSTRAINT channel_accounts_last_webhook_result_ck
    CHECK (last_webhook_result IS NULL OR last_webhook_result IN
      ('aceptado','firma_invalida','sin_secreto','cuenta_desconectada','sin_proveedor','conexion_sin_confirmar'));
END $$;
