# Módulos de IAxTi

Un paquete por módulo de negocio (SPEC §26). Se crean con `/new-module`, no a
mano. Los cuatro del núcleo (`core: true`, nunca se apagan) ya tienen su
esqueleto: `identity`, `organizations`, `authorization`, `audit`.

Los demás se crean en la fase que los implementa:

`crm` · `conversations` · `channels` · `whatsapp` · `webchat` · `agents` ·
`knowledge` · `automations` · `calendar` · `payments` · `integrations` ·
`analytics` · `billing` · `notifications` · `platform`

Estructura de cada módulo: `module.yaml`, `contract.ts` (única puerta
pública), `domain/`, `application/`, `infrastructure/`, `api/`, `events/`,
`tools/`, `migrations/`, `tests/`.
