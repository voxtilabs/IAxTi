# Regla: sistema de módulos

- Estructura de `packages/modules/<id>/`: `module.yaml`, `contract.ts`,
  `domain/`, `application/`, `infrastructure/`, `api/`, `events/`, `tools/`,
  `migrations/`, `tests/`. Se crea con `/new-module`, no a mano.
- `module.yaml` declara: id, versión, core, depends_on (required/optional),
  permisos, eventos (publishes/consumes), tools, nav, widgets, plan_min, flag.
  El catálogo de permisos se genera de aquí: no inventes permisos en código.
- Núcleo inapagable: identity, organizations, authorization, audit. Nada más
  lleva `core: true`. Si un tenant podría querer apagarlo, no es core.
- Todo endpoint del módulo lleva `@RequireModule('<id>')`. Módulo apagado para
  el tenant → `MODULE_DISABLED` con el formato de error único; los datos no se
  tocan.
- Navegación y widgets salen de `GET /me/modules`; el frontend jamás hardcodea
  qué módulos existen.
- Tools del módulo se registran solo si el módulo está activo para el tenant.
- Jobs del módulo se saltan si está apagado (verificar en el worker, no en el
  scheduler).
- Si tocaste un `module.yaml`: corre el test de combinación localmente antes
  del PR. El PR que rompe el arranque con módulos apagados no se mergea.
- Verificación rápida: `/module-check`.
