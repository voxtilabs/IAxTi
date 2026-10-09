# Regla: sistema de módulos

- Estructura de `packages/modules/<id>/`: `module.yaml`, `contract.ts`,
  `domain/`, `application/`, `infrastructure/`, `api/`, `events/`, `tools/`,
  `migrations/`, `tests/`. Se crea con `/new-module`, no a mano.
- `module.yaml` declara: id, versión, core, depends_on (required/optional),
  permisos, eventos (publishes/consumes), tools, nav, widgets, plan_min, flag.
  El catálogo de permisos se genera de aquí: no inventes permisos en código.
- Núcleo inapagable: identity, organizations, authorization, audit. Nada más
  lleva `core: true`. Si un tenant podría querer apagarlo, no es core.
- Todo endpoint del módulo lleva `@RequireModule('<id>')`. Módulo apagado →
  `MODULE_DISABLED` con el formato de error único; los datos no se tocan.
- **Medido (#629):** hoy el apagado es del DESPLIEGUE, no del tenant.
  `modules` vive en `plan_limits` (por plan) y en `platform_module_flags`
  (global); no hay interruptor por tenant en ninguna parte. Lo que el plan no
  incluye queda en `solo_lectura` —con candado, no escondido—, que es SPEC §6:
  bajar de plan nunca borra ni esconde. Que SPEC §26 regla 5 prometa módulos
  por tenant y el producto no los tenga está en #752; hasta que se decida, no
  escribas código que dé por hecho que existen.
- Navegación y widgets salen de `GET /modules/catalogo`; el frontend jamás
  hardcodea qué módulos existen. Esa ruta es el **catálogo del despliegue**, no
  «los módulos de quien mira»: es pública, se pide desde el servidor sin sesión
  y devuelve lo mismo para todos (#629 — antes se llamaba `GET /me/modules`, y
  el nombre hacía creer lo contrario). Lo que depende del negocio es el candado
  por plan, y eso sale de `GET /me/modules/acceso`.
- Tools del módulo se registran solo si el módulo está activo para el tenant.
- Jobs del módulo se saltan si está apagado (verificar en el worker, no en el
  scheduler).
- Si tocaste un `module.yaml`: corre el test de combinación localmente antes
  del PR. El PR que rompe el arranque con módulos apagados no se mergea.
- Verificación rápida: `/module-check`.
