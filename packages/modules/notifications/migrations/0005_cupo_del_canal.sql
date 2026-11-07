-- El dueño se entera del cupo del canal (#1248).
--
-- Mismo movimiento que la 0003, y por eso vale decir qué cambió: esa migración
-- existió porque `pago_recibido` se agregó en TypeScript y nadie tocó el CHECK,
-- así que el INSERT explotaba y el evento se reintentaba para siempre. Desde la
-- #1278 hay una guarda que cruza los dos lados en cada corrida, así que esta
-- migración ya no depende de que alguien se acuerde: si falta, el repo lo dice.
--
-- Aditiva: el constraint se reemplaza por uno más permisivo, así que ninguna
-- fila existente deja de valer y la versión anterior de la aplicación sigue
-- funcionando contra este esquema.
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
    'estado_cuenta',
    'cupo_del_canal'
  ));
