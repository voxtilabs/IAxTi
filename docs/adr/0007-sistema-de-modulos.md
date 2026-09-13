# ADR 0007 · Monolito modular con módulos apagables por tenant

**Estado:** aceptada · 2026-09-13

## Contexto
Los planes se diferencian por módulos y el kill-switch de plataforma debe
existir, pero microservicios son inviables para una persona. "Carpetas
ordenadas" no basta: apagar sin romper exige contrato verificable por máquina.

## Decisión
Monolito modular. Cada módulo es un paquete `packages/modules/<id>/` con
`module.yaml` (id, versión, depends_on required/optional, permisos, eventos,
tools, nav, widgets, plan_min, flag) y `contract.ts` como única puerta pública.
El Module Registry construye el grafo al arrancar, valida ciclos y colisiones,
inicializa en orden topológico y expone `GET /health/modules`. Dos
interruptores: plataforma (kill-switch) y tenant (plan + flag). Eventos por
outbox; opcionales por `capabilities.get()` que degrada con null. Núcleo
inapagable: identity, organizations, authorization, audit.

## Consecuencias
- `dependency-cruiser` en CI falla el PR ante un import fuera de `contract.ts`.
- Test de combinación en CI: cada módulo solo con sus required; la app con todo
  apagado menos el núcleo.
- Apagado responde `MODULE_DISABLED` sin tocar datos; desinstalar es otra
  acción, con exportación previa.

## Se revisa cuando
Nunca. Es el requisito crítico del producto (SPEC §26).
