-- Un video y una reacción dejan de perderse (#1266).
--
-- `TIPOS` en el adaptador de Zavu produce 13 valores; este CHECK aceptaba 8.
-- `video` y `reaccion` no estaban, así que el INSERT los rechazaba y
-- `withTenant` revertía la transacción ENTERA: se perdía el mensaje y, si era
-- el primero de esa persona, también su contacto y su conversación. Para el
-- cliente, dos ticks; para el negocio, nada. Y como el entrante no quedaba,
-- `last_inbound_at` no se movía y la ventana de 24 h nunca se abría.
--
-- Aditiva de verdad: un CHECK que se ENSANCHA no invalida ninguna fila
-- existente, así que la versión anterior de la aplicación sigue funcionando
-- con este esquema — que es lo que la regla de migraciones pide.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (type IN ('texto','imagen','audio','documento','ubicacion',
                  'contacto','plantilla','interactivo','video','reaccion'));
