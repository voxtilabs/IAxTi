# Plan de implementación por semanas

Cada fase tiene su milestone en GitHub y sus issues como tracer bullets con
dependencias ("Bloqueado por #n"). Las épicas #19–#23 son los paraguas de las
fases 2–6. Este plan reparte los issues por semana; el orden dentro de la
semana lo dan las dependencias.

## Fase 1 · Fundación (semanas 1–3) — milestone "Fase 1 · Fundación"

| Semana | Issues | Qué queda funcionando |
|---|---|---|
| 1 | #1 scaffold · #2 Docker/compose · #3 CI base · #4 db/RLS · #5 Module Registry | Monorepo compila, compose local levanta, CI verde, RLS probado, registry con manifiestos del núcleo |
| 2 | #6 dependency-cruiser · #7 identity · #8 organizations · #9 authorization · #10 audit | Núcleo completo: login, tenant con ciclo de vida, guards, audit encadenado |
| 3 | #11 API base · #12 rate limiting · #13 BullMQ · #14 test de combinación · #15 Dokploy staging · #16 Cloudflare · #17 observabilidad · #18 seed | Staging desplegado tras Cloudflare, OpenAPI publicado, colas andando |

**Criterio de salida:** test de combinación verde; tenant de prueba con dos
usuarios y roles (#18).

## Fase 2 · CRM núcleo (semanas 4–7) — épica #19

| Semana | Issues |
|---|---|
| 4 | #27 tokens Pulso · #28 shell web · #29 shell admin · #30 crm contactos |
| 5 | #31 pipelines/oportunidades · #32 actividades/ficha · #35 conversations modelo · #36 simulador |
| 6 | #33 kanban/lista · #37 bandeja Realtime · #38 asignación/SLA |
| 7 | #34 fusión/CSV · #39 quick replies/notas/búsqueda · #40 cierre y archivo |

**Criterio de salida:** un supervisor asigna una conversación simulada y la
resuelve desde el celular.

## Fase 3 · IA + WhatsApp (semanas 8–11) — épica #20

| Semana | Issues |
|---|---|
| 8 | #41 puerto channels · #42 Kapso entrante · #47 runtime agents + Langfuse |
| 9 | #43 salientes/24h · #44 plantillas · #48 copiloto assist · #51 knowledge |
| 10 | #45 calidad número · #46 webchat · #49 autónomo · #50 configurador · #52 cuota |
| 11 | #53 evaluación · #54 GLM (decisión) · #55 notifications · #56 onboarding 10 min |

**Criterio de salida: demo vendible** — onboarding completo en 10 minutos con
número real. Aquí se sale a vender.

## Fase 4 · Agenda y cobro (semanas 12–14) — épica #21

| Semana | Issues |
|---|---|
| 12 | #57 calendar conexión · #58 citas · #60 payments links |
| 13 | #59 recordatorios · #61 webhook pagos · #62 motor de reglas · #63 secuencias |
| 14 | #64 Drive · #65 Gmail · #66 analytics v1 · #67 billing |

**Criterio de salida:** primer cliente en prueba gratis.

## Fase 5 · Crecimiento (con feedback real) — épica #22

Sin semanas: se ordena con feedback de clientes. Issues: #68–#72 SuperAdmin,
#73 roles custom, #74 IG/Messenger, #75 envíos segmentados, #76 webhooks
salientes, #77 retención, #78 notifications v2, #24–#26 API por tenant,
#85 WhatsApp Flows, #86 spike llamadas de voz.

**Criterio de salida:** diez clientes pagando.

## Fase 6 · Hardening (con volumen) — épica #23

#79 load testing · #80 DR probado · #81 matriz de compliance completa ·
#82 spike Tech Provider · #83 GKE condicional · #84 particionado de messages.

**Criterio de salida:** primer contrato de tratamiento de datos atendido sin
improvisar.

## Reglas del plan

- Nada de una fase posterior se adelanta (SPEC §5, §31).
- Un issue `size:l` se parte antes de tomarse. Más de 3 días en In progress:
  se parte o se cierra con explicación.
- Al cerrar cada fase: `/handoff`, revisión de la matriz de compliance y
  actualización de este plan con lo aprendido.
