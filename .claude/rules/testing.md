# Regla: testing

- Toda funcionalidad nueva tiene tests que cubren sus criterios de aceptación
  (el Issue los lista; el PR los referencia).
- Pirámide práctica: unit para dominio y casos de uso; integration con
  Postgres y Redis reales (en CI levantados como servicios) para repositorios,
  RLS, colas y webhooks; e2e solo para los flujos que son criterio de salida
  de fase (bandeja desde el celular, onboarding 10 min).
- Tests obligatorios por tipo de cambio:
  - Tabla nueva → test de RLS (tenant A no ve B).
  - Endpoint nuevo → test del guard (sin permiso → 403 formato único) y del
    contrato OpenAPI.
  - Evento nuevo → test de idempotencia del consumidor.
  - `module.yaml` tocado → test de combinación de módulos.
  - Tool de IA nueva → test de que pasa por el guard y de que no borra.
- Cambio de prompt, modelo o proveedor de IA → corre el dataset de regresión
  del agente; no se mergea con score menor a la versión anterior (#53).
- Los tests usan el seed (#18) como base; datos anonimizados, jamás datos
  reales de clientes en fixtures.
- `/tdd` cuando el criterio de aceptación lo permite: test primero.
