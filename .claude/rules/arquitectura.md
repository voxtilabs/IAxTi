# Regla: arquitectura

- Monolito modular NestJS. Apps: web, admin (Next.js), api, workers, agents
  (misma imagen, distinto entrypoint). `packages/core` no conoce ningún módulo
  de negocio.
- Sin lógica de negocio en controllers: el controller valida, llama al caso de
  uso y mapea la respuesta. El caso de uso vive en `application/`.
- `domain/` no importa infraestructura. `infrastructure/` implementa los
  puertos de `application/`.
- Un módulo importa de otro SOLO por su `contract.ts`. Si necesitas algo que el
  contrato no expone, se agrega al contrato en un PR del módulo dueño — no se
  importa el archivo interno.
- Dependencias opcionales: `capabilities.get('<id>')`; si es null, la función
  degrada (la acción no aparece, la regla se pausa con aviso). Jamás asumir
  que un módulo opcional existe.
- Comunicación entre módulos por eventos del catálogo (SPEC §24): outbox
  transaccional, consumidores idempotentes, el publicador no conoce al
  consumidor. Agregar un evento = editar el manifiesto y el catálogo.
- Cambio que cruza más de un módulo: `/zoom-out` antes, y el PR explica por
  qué cruza y por dónde (contratos y eventos tocados).
- Decisión de arquitectura nueva o desvío de un ADR: `/new-adr` primero.
