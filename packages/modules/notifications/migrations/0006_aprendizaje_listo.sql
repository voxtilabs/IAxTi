-- El aviso de que lo aprendido de los chats quedó listo (#1406, ADR-0039).
--
-- La dueña autorizó la lectura y se fue a atender el negocio: el historial
-- de Meta puede tardar, y cuando el job termina, ella no está mirando la
-- pantalla de Canales. Sin este aviso, lo aprendido espera una revisión que
-- nadie sabe que ya se puede hacer — y mientras tanto el asistente sigue sin
-- saber cómo atiende el negocio.
--
-- Mismo movimiento que la 0005, y protegido por la misma guarda (#1278):
-- `tipos-y-la-base.test.ts` cruza `NOTIFICATION_TYPES` con este CHECK, así
-- que el tipo no puede quedar de un solo lado. Aditiva: el constraint se
-- reemplaza por uno más permisivo.
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
    'cupo_del_canal',
    'aprendizaje_listo'
  ));
