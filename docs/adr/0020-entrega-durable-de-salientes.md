# ADR 0020 · El pedido de salida se confirma con el mensaje

**Estado:** implementada por fases para #380 · 2026-09-20

## Contexto

PostgreSQL y Redis no comparten transacción. Encolar antes del commit permite que
el worker no vea el mensaje o que sobreviva un job a un rollback. Encolar después
deja una ventana donde un fallo de la API/Redis pierde el trabajo pendiente.

## Decisión

Reutilizar el outbox de ADR-0004. `sendMessage` admite una política explícita
`reply`, `business` o `transactional`; para canales por proveedor escribe
`message.delivery_requested` y auditoría en la misma transacción que el mensaje.
El evento contiene solo messageId/política; tenant y requestId van en el sobre.
Si hay una traza activa, conserva su traceparent W3C en metadata técnica para
continuarla al encolar. No copia baggage, cabeceras, cuerpos ni credenciales.

Workers convierte el pedido a la cola outbound existente, con `out-<messageId>`
estable. Conserva initiatedByBusiness y la excepción de ADR-0016; el procesador
vuelve a validar el estado actual, consentimiento, ventana, plantilla y silencio.

La conexión publicadora a Redis tiene espera acotada y se descarta ante error o
timeout. Un fallo revierte el claim del consumidor. El publicador frena nuevas
conexiones durante un segundo después del fallo para no repetir la espera por
cada elemento del lote. El outbox conserva el pedido y su error durante los cinco intentos existentes; los agotados son visibles en
el tablero de salud. La recuperación debe volver a habilitar solo un pedido
pendiente de ese tenant/mensaje y dejar auditoría, sin recrear el mensaje.

Para este consumidor, un módulo apagado conserva el evento pendiente con error.
Se agrega una opción explícita de reintento al despachador; los consumidores
existentes mantienen su semántica de saltar módulos apagados. No se ejecuta el
handler del módulo deshabilitado.
Si el módulo se apaga después de aceptar Redis, la cola outbound aplaza el job
un minuto sin completarlo ni gastar intentos; al reactivarse continúa. Las otras
colas mantienen su comportamiento anterior.

## Despliegue y compatibilidad

Primero se despliega el receptor y el contrato opcional, sin migrar emisores.
Después de verificar esa imagen en staging se migran los emisores. Así ningún
productor publica eventos que una versión anterior desconozca. El rollback de
la migración vuelve a la imagen que ya contiene el receptor; no a una anterior.

La segunda fase migra respuestas humanas y sugerencias, plantillas/campañas,
links de pago, respuestas autónomas, automatizaciones/secuencias y comprobantes.
Estos últimos confirman el pago y su pedido de aviso juntos: un fallo SQL se
propaga al worker para reintentar el webhook; una caída de Redis no revierte el pago.

La recuperación se expone en
`POST /v1/conversations/:id/messages/:mid/retry-delivery`, con permiso
`conversations.reply`, módulo activo y comprobación de dueño/read_all. Nunca
reinicia un mensaje enviado ni altera su política original. Un 409 indica que
no hay un pedido agotado recuperable; los errores de infraestructura siguen
siendo errores del servidor. El procesador revalida las reglas al enviarlo.

No requiere tablas ni migraciones nuevas, otro broker ni credenciales nuevas.
No se rebobinan ni reenvían automáticamente mensajes históricos.

## Límites

El ID de BullMQ y la comprobación del mensaje ya entregado hacen idempotente la
repetición del despacho. No prometen exactly-once frente a un proveedor externo
que acepta un envío justo antes de que el proceso muera sin guardar el resultado.
Los pedidos agotados necesitan recuperación explícita; no desaparecen ni se
declaran entregados por haber alcanzado Redis.
