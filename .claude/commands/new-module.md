---
description: Crea un módulo nuevo con manifiesto, contrato, migración y tests según el SPEC
---

Crea el módulo `$ARGUMENTS` en `packages/modules/$ARGUMENTS/`:

1. Lee `docs/SPEC.md` (la sección del módulo en la Parte B si existe, y §26) y
   `.claude/rules/modulos.md`.
2. Genera la estructura completa: `module.yaml` (id, versión 0.1.0, core:
   false, depends_on según la Parte B, permisos, eventos publishes/consumes
   del catálogo §24, tools, nav, widgets, plan_min, flag), `contract.ts`
   vacío-pero-tipado, `domain/`, `application/`, `infrastructure/`, `api/`,
   `events/`, `tools/`, `migrations/0001_init.sql` (tablas con `tenant_id` +
   RLS + índices), `tests/` con: test de RLS, test del guard, test de
   combinación (arranca solo con required).
3. Registra el paquete en pnpm-workspace si hace falta y verifica que
   `pnpm turbo build` y el test de combinación pasan.
4. No inventes permisos ni eventos fuera del manifiesto; si el SPEC no define
   el módulo, detente y pide la definición.
