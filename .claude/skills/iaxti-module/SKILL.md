---
name: iaxti-module
description: Crear o modificar un módulo de IAxTi - manifiesto, contrato, migraciones, tests de combinación. Usar al crear un módulo, tocar un module.yaml, agregar permisos/eventos/tools, o cuando un import entre módulos falle el dependency-cruiser.
---

# Módulos de IAxTi

Un módulo es un paquete en `packages/modules/<id>/` que se puede apagar por
tenant sin romper nada. Lee `.claude/rules/modulos.md` y SPEC §26 antes de
tocar uno.

## Crear un módulo

Usa `/new-module <id>`. Estructura obligatoria: `module.yaml`, `contract.ts`
(única puerta pública), `domain/` (sin imports de infraestructura),
`application/` (casos de uso y puertos), `infrastructure/`, `api/`
(controllers con guards), `events/`, `tools/`, `migrations/`, `tests/`.

## Manifiesto: el contrato con el registro

Todo lo que el módulo declara vive en `module.yaml`: permisos (el catálogo se
genera de aquí), eventos que publica y consume (nombres del catálogo SPEC
§24), tools, nav, widgets, plan_min y flag. Si el código usa un permiso o
publica un evento que el manifiesto no declara, el arranque falla — esa es la
gracia.

## Los cuatro errores que rompen el sistema

1. Importar un archivo interno de otro módulo → agrega lo que necesitas al
   `contract.ts` del dueño, en su PR.
2. Consultar una tabla de otro módulo → pide un método de contrato o consume
   su evento.
3. Asumir que un opcional existe → `capabilities.get('<id>')` y degradar con
   null.
4. Meter en core algo apagable → solo identity, organizations, authorization
   y audit son core.

## Antes del PR

Corre el test de combinación si tocaste el manifiesto (`pnpm turbo test
--filter=...` del módulo + arranque con solo required). `/module-check` sobre
el diff.
