# Recuperar un pedido de entrega agotado

Desde #380, guardar un saliente por proveedor también guarda su pedido de envío
en PostgreSQL. El dispatcher intenta pasarlo a Redis cinco veces. Si se agotan,
el mensaje sigue `queued`; el outbox conserva el error y el tablero de salud
cuenta el pedido abandonado. No se declara enviado por haber llegado a Redis.

1. Revisar el error y restaurar Redis o reactivar el módulo que estaba apagado.
2. Identificar el tenant, la conversación y el mensaje pendiente. Confirmar que
   el pedido corresponde a ese mensaje; no recuperar un lote histórico a ciegas.
3. Con la identidad autorizada del tenant, llamar a
   `POST /v1/conversations/{conversationId}/messages/{messageId}/retry-delivery`.
   Requiere `conversations.reply` y ser dueño, estar sin dueño o disponer de
   `conversations.read_all`. Una API key necesita los scopes correspondientes.
4. Un `201` habilita el mismo pedido y registra `message.delivery_retried` en
   auditoría. Comprobar después el estado del mensaje y los errores del outbox.
   El worker vuelve a revisar consentimiento, ventana, plantilla, cuenta y
   horario de silencio antes de llamar al proveedor.

Un `409 DELIVERY_NOT_RETRYABLE` significa que no hay un pedido agotado pendiente
recuperable para ese mensaje: puede estar activo, procesado o ser un mensaje
ya enviado/fallido. No modificar la tabla ni recrear el mensaje para evitar esa
respuesta. Un error de infraestructura conserva su estado para poder repetir
la operación cuando la dependencia esté sana.

Si el módulo se apaga después de pasar a Redis, el trabajo espera un minuto y
se vuelve a evaluar; no se completa ni gasta intentos durante esa espera.

El ID estable y la comprobación del estado evitan repetir un envío ya registrado.
No permiten asegurar una única entrega si el proveedor aceptó el mensaje justo
antes de que el proceso muriera sin guardar el resultado. Ante ese caso, revisar
el resultado con el proveedor antes de intentar otra entrega.

El rollback de los emisores debe usar una imagen que ya contenga el receptor
de #384. Una versión anterior no conoce el evento y podría descartarlo.
