-- El CHECK de `type` se quedó atrás (issue 273).
--
-- `pago_recibido` se agregó a NOTIFICATION_TYPES en TypeScript, con su texto
-- y su consumidor, y nadie tocó la base: el compilador no ve el CHECK y el
-- CHECK no ve el tipo. Resultado: el cliente paga, el consumidor arma el
-- aviso, el INSERT explota y el evento se reintenta para siempre.
--
-- Se agrega también `estado_cuenta`, para el aviso de cambio de estado del
-- tenant que este mismo PR conecta.
--
-- Aditiva: el constraint se reemplaza por uno más permisivo, así que
-- ninguna fila existente deja de valer y la versión anterior de la
-- aplicación sigue funcionando contra este esquema.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversacion_sin_dueno',
    'sla_vencido',
    'mencion',
    'tarea_vencida',
    'cuota_ia',
    'calidad_numero',
    'pago_recibido',
    'estado_cuenta'
  ));
