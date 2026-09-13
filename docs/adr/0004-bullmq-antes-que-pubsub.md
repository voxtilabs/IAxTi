# ADR 0004 · BullMQ antes que Pub/Sub

**Estado:** aceptada · 2026-09-13

## Contexto
Los webhooks nunca procesan en línea; todo pasa por colas con reintentos, cron
y prioridades. Kafka o Pub/Sub agregan infraestructura y operación que el
volumen de la etapa 1 no justifica.

## Decisión
BullMQ sobre Redis. Seis colas por naturaleza: `inbound`, `outbound`,
`automations`, `sync`, `scheduled`, `agents`. Jobs repetibles en zona
`America/Santiago`. Patrón job padre → hijo por tenant para que un tenant grande
no bloquee a los demás. Eventos de dominio por outbox transaccional en Postgres,
no por la cola.

## Consecuencias
- Redis es infraestructura crítica: AOF, backup diario a R2, contraseña.
- Los workers son el mismo código con otro entrypoint (misma imagen).
- Jobs de módulos apagados se saltan (regla 5 del sistema de módulos).

## Se revisa cuando
Más de un nodo → Redis gestionado (Upstash o equivalente). Volumen o garantías
de entrega que Redis no cubra → Pub/Sub, con medición que lo demuestre.
