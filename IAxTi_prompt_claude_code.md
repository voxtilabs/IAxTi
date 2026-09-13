# IAxTi — Prompt de arranque para Claude Code

Pega esto como primer mensaje en Claude Code dentro de un repositorio vacío
(después de correr los comandos de instalación de skills del final).

---

Actúa como Principal Architect + Staff Engineer de IAxTi, un CRM conversacional
SaaS multi-tenant para pymes chilenas, con WhatsApp como canal principal, agentes
de IA que asisten al vendedor, y arquitectura de monolito modular con módulos que
se pueden activar y desactivar por tenant sin romper nada.

## Decisiones ya tomadas (no las reabras, aplícalas)

Stack: TypeScript de punta a punta. Monorepo con pnpm workspaces y Turborepo.
- `apps/web`: Next.js + TypeScript + Tailwind + shadcn/ui (app cliente).
- `apps/admin`: Next.js (SuperAdmin control plane).
- `apps/api`: NestJS, monolito modular, OpenAPI 3.1, guards de módulo y permisos.
- `apps/workers`: mismo código, punto de entrada para BullMQ.
- `apps/agents`: Vercel AI SDK + Chat SDK (adaptador Kapso) + tools expuestas como MCP.
- `packages/modules/*`: un paquete por módulo de negocio con `module.yaml`.
- `packages/core`: registro de módulos, contratos, eventos, tenancy, auth, audit.
- `packages/db`: esquema Postgres, migraciones por módulo, RLS.
- `infra/`: Terraform (GCP, un proyecto por ambiente), Dockerfile único, Helm chart preparado.

Datos e identidad: Supabase (Postgres + pgvector con RLS, Auth con Google OAuth y MFA,
Realtime para la bandeja). La API es la única puerta de entrada; el frontend nunca
consulta tablas directamente.

Cómputo: Docker → Cloud Run (api, workers, agents desde la misma imagen). GKE y
Argo CD quedan documentados como fase futura, no se implementan ahora.

Colas: BullMQ sobre Redis. Sin Kafka ni Pub/Sub.

WhatsApp: Kapso como proveedor, detrás de un puerto `WhatsAppProvider` con vocabulario
de la Cloud API de Meta (phone_number_id, waba_id, message ids, templates, ventana 24h)
para poder migrar a Tech Provider propio después. Kapso no guarda lógica de negocio.

IA: Gemini vía Vertex AI. Langfuse Cloud para trazas, costos y evaluaciones de agentes;
OpenTelemetry → Grafana Cloud para plataforma; Sentry para errores. Mismo `trace_id`
en las tres capas. El LLM nunca accede a la base de datos: solo a tools MCP
autorizadas con el tenant y permisos del usuario.

Integraciones: Google Calendar, Drive y Gmail con OAuth incremental por usuario,
tokens en Secret Manager, sincronización por push notifications, expuestas como
tools MCP internas. Pasarela de pago (Webpay / Flow / Mercado Pago) por webhook.

## Sistema de módulos (requisito crítico)

Cada módulo en `packages/modules/<id>/` contiene:
`module.yaml`, `domain/`, `application/`, `infrastructure/`, `api/`, `events/`,
`tools/`, `migrations/`, `tests/`, `contract.ts`.

Reglas:
1. Un módulo solo importa de otro a través de su `contract.ts`. `dependency-cruiser`
   lo verifica en CI y falla el PR si se viola.
2. `module.yaml` declara id, versión, `depends_on.required`, `depends_on.optional`,
   permisos, eventos publicados y consumidos, tools, navegación y widgets.
3. El Module Registry lee los manifiestos al arrancar, construye el grafo, valida
   ciclos y colisiones, inicializa en orden topológico y expone health por módulo.
4. Dos interruptores: plataforma (SuperAdmin, con kill-switch) y tenant (Admin según
   plan y feature flag). No se puede apagar un módulo del que otro activo depende.
5. Módulo apagado para un tenant: endpoints responden `MODULE_DISABLED`, navegación
   y widgets desaparecen (`GET /me/modules`), tools no se registran, jobs se saltan.
   Los datos no se tocan. Desinstalar es acción aparte con exportación previa.
6. Eventos: outbox transaccional, consumidores idempotentes, publicador nunca conoce
   al consumidor. Dependencias opcionales se resuelven con `capabilities.get()` y
   degradan si devuelven null.
7. Núcleo que nunca se apaga: `identity`, `organizations`, `authorization`, `audit`.
8. Test de combinación en CI: cada módulo arranca solo con sus dependencias
   obligatorias, y la app arranca con todo apagado menos el núcleo.

## Autorización

Roles base SUPERADMIN, ADMIN, SUPERVISOR, USER como paquetes de permisos, más roles
personalizados por tenant. Nunca `if (role === 'ADMIN')` en el código: siempre
`@RequirePermission('crm.contacts.update')` + verificación de tenant + verificación
de dueño del objeto. RLS en Postgres como segunda cerradura. Las tools de los agentes
pasan por el mismo guard con la identidad del usuario que conversa.

## Reglas absolutas

- Sin lógica de negocio en controllers. Sin acceso directo entre módulos.
- Toda operación respeta el tenant context. Toda mutación importante se audita
  (actor, tenant, acción, recurso, IP, user agent, resultado, metadata) en tabla
  append-only.
- Toda API pública tiene OpenAPI. Toda funcionalidad nueva tiene tests.
- Toda migración está versionada y es aditiva. Nada de secrets en Git.
- Errores con formato `{ code, message, requestId, details[] }`.
- No afirmar cumplimiento ISO ni legal: la arquitectura es "auditable", la
  certificación es un proceso aparte.
- Cada decisión arquitectónica importante genera un ADR en `docs/adr/`.
- Si encuentras una decisión de arriba que sea mala, contradíceme y explica por qué
  antes de implementar.

## Lo que quiero ahora, en este orden

FASE 0 — No escribas código de producto todavía.

1. Corre `/setup-matt-pocock-skills` para configurar el repo (issue tracker: GitHub).
2. Corre `/grill-me` sobre este plan: hazme las preguntas que necesites para cerrar
   ambigüedades, con tus respuestas recomendadas.
3. Genera en `docs/`:
   - `ARCHITECTURE.md` con diagramas Mermaid (infra, módulos, permisos, flujo de
     un mensaje de WhatsApp de punta a punta).
   - `docs/adr/0001` a `0008`: stack TypeScript, Supabase como datos e identidad,
     Cloud Run antes que GKE, BullMQ antes que Pub/Sub, Kapso ahora y Tech Provider
     después, Langfuse + OpenTelemetry, sistema de módulos, modelo de autorización.
   - `SECURITY_BASELINE.md` y `COMPLIANCE_BASELINE.md` con matriz
     Control · ISO 27001 · ISO 27701 · ISO 42001 · OWASP ASVS · Ley 21.719 ·
     Implementación · Estado (técnico / organizacional / legal / contractual).
   - `IMPLEMENTATION_PLAN.md` por semanas: fundación (1–3), CRM núcleo (4–7),
     IA + WhatsApp (8–11), integraciones Google (12–14), SuperAdmin y hardening.
4. Genera `CLAUDE.md` con las reglas de este documento en forma operativa, y
   `.claude/` con: `rules/` (arquitectura, módulos, seguridad, testing, API, DB,
   git), `commands/` (`/new-module`, `/new-adr`, `/security-review`,
   `/module-check`), `agents/` (reviewer de arquitectura, reviewer de seguridad),
   `hooks/` (pre-commit: lint, typecheck, dependency-cruiser, gitleaks).
5. Corre `/to-issues` sobre `IMPLEMENTATION_PLAN.md` para crear los issues de la
   fase 1 en GitHub como tracer bullets con dependencias.
6. Corre `/handoff` y detente. Espera mi aprobación antes de la FASE 1.

---

## Instalación previa de skills (una sola vez, en la terminal)

Skills oficiales de Anthropic (repo `anthropics/skills`, también en el marketplace
oficial `@claude-plugins-official`): `skill-creator`, `mcp-builder`, `webapp-testing`,
`frontend-design`.

Skills de Matt Pocock (repo `mattpocock/skills`, en el marketplace oficial):
`setup-matt-pocock-skills`, `grill-me`, `wayfinder`, `to-prd`, `to-issues`, `triage`,
`handoff`, `zoom-out`, `improve-codebase-architecture`, `tdd`, `domain-model`.

```bash
npx skills@latest add mattpocock/skills \
  --skill setup-matt-pocock-skills --skill grill-me --skill wayfinder \
  --skill to-prd --skill to-issues --skill triage --skill handoff \
  --skill zoom-out --skill improve-codebase-architecture --skill tdd \
  --skill domain-model -y
```

Dentro de Claude Code, para los oficiales:

```
/plugin install skill-creator@claude-plugins-official
/plugin install mcp-builder@claude-plugins-official
/plugin install frontend-design@claude-plugins-official
/plugin install webapp-testing@claude-plugins-official
```

Verifica los nombres exactos con `/plugin` antes de instalar; el marketplace cambia.

Skills que NO existen como oficiales y deben crearse internas con `skill-creator`:
`iaxti-module` (crear un módulo con manifiesto, contrato, tests y migración),
`iaxti-permissions` (catálogo y guards), `iaxti-kapso` (contrato del proveedor
WhatsApp), `iaxti-compliance` (mantener la matriz al día con cada feature).
