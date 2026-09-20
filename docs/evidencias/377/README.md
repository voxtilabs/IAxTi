# #377 · Sondeo de outbox sin lotes superpuestos

`start(500)` lanzaba un tick en cada intervalo aunque el lote anterior siguiera
esperando una consulta o un consumidor. SKIP LOCKED evita procesar una misma fila,
pero no limita las transacciones ni las solicitudes de conexión del proceso.

## Reproducción y cambio

Con el primer lote retenido durante 30 segundos, el test observaba 60 llamadas a
tick. Ahora observa una; tras terminar el lote, el siguiente intervalo vuelve a
procesar. También se libera el sondeo tras un error. Stop/start conserva el lote
en curso y no abre otro hasta que termine.

El límite es por instancia y solo afecta al sondeo automático. Se conserva tick
explícito, la coordinación entre procesos mediante SKIP LOCKED, las transacciones,
los consumidores idempotentes y los reintentos. No agrega dependencias ni cambia
el esquema, el catálogo de eventos o la configuración del servidor.

## Validación

- Antes del cambio: 3 de 4 pruebas de intervalos fallaban.
- Después: 4 de 4 correctas, con reloj controlado y un lote retenido.
- Regresión de core: 83 pruebas correctas, incluidas outbox real con PostgreSQL,
  reintentos, idempotencia, colas con Redis y combinaciones de módulos.

## Límites

Un consumidor que nunca termina todavía detiene el avance de esa instancia; el
cambio evita que además agote el pool acumulando lotes. Los límites y recuperación
de llamadas externas siguen siendo responsabilidad de sus transportes.

La entrega durable PostgreSQL→Redis de los productores de mensajes requiere una
corrección separada: este cambio no afirma resolverla ni cambia envíos a clientes.
