# IAxTi — Especificación y prompt de arranque

Documento definitivo para construir IAxTi con Claude Code. Se pega completo como
primer mensaje en un repositorio vacío, y después vive en `docs/SPEC.md` como fuente
de verdad. Versión 1.0 · septiembre 2026 · producto de VoxTi Labs, interfaz según
el sistema de diseño Pulso.

---

## Índice

1. [Qué es IAxTi](#1-qué-es-iaxti)
2. [Principios](#2-principios)
3. [Stack y decisiones cerradas](#3-stack-y-decisiones-cerradas)
4. [Repositorio](#4-repositorio)
5. [Sistema de módulos](#5-sistema-de-módulos)
6. [Multi-tenancy y datos](#6-multi-tenancy-y-datos)
7. [Autorización](#7-autorización)
8. [API](#8-api)
9. [Canales y WhatsApp](#9-canales-y-whatsapp)
10. [Agentes de IA](#10-agentes-de-ia)
11. [Integraciones](#11-integraciones)
12. [Automatizaciones y colas](#12-automatizaciones-y-colas)
13. [Auditoría y privacidad](#13-auditoría-y-privacidad)
14. [Observabilidad](#14-observabilidad)
15. [Infraestructura y entornos](#15-infraestructura-y-entornos)
16. [DevSecOps y GitHub](#16-devsecops-y-github)
17. [SuperAdmin](#17-superadmin)
18. [Interfaz: sistema Pulso](#18-interfaz-sistema-pulso)
19. [Compliance](#19-compliance)
20. [Roadmap](#20-roadmap)
21. [Claude Code](#21-claude-code)
22. [Fase 0: lo que haces ahora](#22-fase-0-lo-que-haces-ahora)
23. [Antes de cualquier PR](#23-antes-de-cualquier-pr)

---

## 1. Qué es IAxTi

CRM conversacional SaaS multi-tenant para pymes chilenas de 1 a 15 personas que ya
venden por WhatsApp. Se arma solo con una IA que configura el CRM en 15 minutos,
tiene un copiloto que asiste al vendedor (y responde solo cuando el dueño lo permite),
agenda en Google Calendar y cobra con links de pago desde el chat.

Compite por abajo de Vambe y Cliengo: sin implementación, sin consultor, un plan
por negocio, costos de Meta e IA visibles. Omnicanal por diseño, WhatsApp primero.

Actúa como Principal Architect + Staff Engineer. El equipo somos tú y yo, con dos
personas ocasionales. Cada decisión se toma para una persona que mantiene esto sola.

---

## 2. Principios

Reglas absolutas. Si una tarea las contradice, la tarea está mal planteada.

1. Monolito modular. Sin microservicios. Los módulos se activan y desactivan por
   tenant sin romper nada (sección 5).
2. Sin lógica de negocio en controllers. Sin acceso directo entre módulos.
3. Toda operación respeta el tenant context. Toda operación sensible está autorizada.
4. Toda mutación importante se audita en tabla append-only.
5. El LLM nunca toca la base de datos. Solo tools autorizadas con la identidad del
   usuario que conversa.
6. Toda API pública tiene OpenAPI. Toda funcionalidad nueva tiene tests. Toda
   migración está versionada y es aditiva.
7. Nada de secrets en Git. Nada de hex suelto en la interfaz (sección 18).
8. No se afirma cumplimiento ISO ni legal. La arquitectura es auditable; la
   certificación es un proceso aparte.
9. Cada decisión arquitectónica importante genera un ADR en `docs/adr/`.
10. No se agregan tecnologías por moda. Si una de las decisiones de la sección 3 te
    parece mala, contradíceme con argumentos antes de implementar.

---

## 3. Stack y decisiones cerradas

| Área | Decisión | Por qué | Se difiere |
|---|---|---|---|
| Lenguaje | TypeScript de punta a punta | Un runtime, un modelo de dominio, un pipeline | — |
| Frontend | Next.js + Tailwind + shadcn/ui, tokens Pulso | Claude Code lo produce contra OpenAPI | — |
| Backend | NestJS, monolito modular | Módulos declarativos, guards, OpenAPI nativo | — |
| Agentes | Vercel AI SDK + Chat SDK (adaptador Kapso), tools MCP | Ecosistema TS, adaptador oficial | ADK/Python |
| Datos | Supabase: Postgres + pgvector, RLS, Auth, Realtime | Auth con Google incluido, RLS nativo, inbox en vivo | Cloud SQL si un cliente exige residencia |
| Cómputo | Docker → Cloud Run (api, workers, agents) | Mismo contenedor, sin operar clúster | GKE + Helm + Argo CD |
| Colas | BullMQ sobre Redis | Reintentos, cron, prioridades sin infraestructura extra | Pub/Sub |
| WhatsApp | Kapso detrás de un puerto `WhatsAppProvider` | Onboarding multi-tenant resuelto hoy | Meta Tech Provider propio |
| LLM | Gemini vía Vertex AI | Costo y calidad, misma nube | Segundo proveedor por config |
| Observabilidad | Langfuse Cloud + OpenTelemetry → Grafana Cloud + Sentry | Nadie opera nada | Langfuse self-hosted |
| Borde | Cloudflare | DNS, WAF, rate limiting, bots | — |
| IaC | Terraform, un proyecto GCP por ambiente | Aislamiento real dev/staging/prod | — |
| CI/CD | GitHub Actions | Ya está donde vive el código | — |

Lo diferido queda documentado en un ADR con la condición que lo activa. No se
implementa antes.

---

## 4. Repositorio

Monorepo con pnpm workspaces y Turborepo.

```
iaxti/
├── apps/
│   ├── web/            Next.js, app cliente (CRM, inbox, copiloto)
│   ├── admin/          Next.js, SuperAdmin control plane
│   ├── api/            NestJS, punto de entrada HTTP
│   ├── workers/        mismo código, punto de entrada BullMQ
│   └── agents/         mismo código, punto de entrada de agentes
├── packages/
│   ├── core/           registro de módulos, contratos, eventos, tenancy, auth, audit
│   ├── db/             esquema, migraciones por módulo, políticas RLS
│   ├── ui/             componentes shadcn tematizados con Pulso
│   ├── sdk/            cliente TypeScript generado desde OpenAPI
│   └── modules/
│       ├── identity/
│       ├── organizations/
│       ├── authorization/
│       ├── audit/
│       ├── crm/
│       ├── conversations/
│       ├── channels/
│       ├── whatsapp/
│       ├── agents/
│       ├── automations/
│       ├── integrations/
│       ├── calendar/
│       ├── payments/
│       ├── analytics/
│       ├── billing/
│       └── notifications/
├── infra/
│   ├── docker/         Dockerfile único, compose para local
│   ├── terraform/      módulos por ambiente
│   └── helm/           chart preparado, no desplegado
├── docs/
│   ├── SPEC.md         este documento
│   ├── ARCHITECTURE.md diagramas Mermaid
│   ├── adr/
│   ├── SECURITY_BASELINE.md
│   ├── COMPLIANCE_BASELINE.md
│   └── IMPLEMENTATION_PLAN.md
├── .claude/            sección 21
├── .github/            workflows, CODEOWNERS, plantillas de issue y PR
└── CLAUDE.md
```

Un módulo por paquete. `packages/core` no conoce ningún módulo de negocio.

---

## 5. Sistema de módulos

Requisito crítico. Es lo que separa "carpetas ordenadas" de "apagar sin romper".

### Estructura de un módulo

```
packages/modules/<id>/
├── module.yaml       manifiesto
├── contract.ts       única puerta pública
├── domain/           entidades, value objects, reglas; sin imports de infraestructura
├── application/      casos de uso, puertos
├── infrastructure/   repositorios, adaptadores, clientes externos
├── api/              controllers con @RequireModule + @RequirePermission
├── events/           publicados y consumidos, por nombre
├── tools/            tools MCP que el módulo expone a los agentes
├── migrations/       versionadas, solo aditivas
└── tests/
```

### Manifiesto

```yaml
module:
  id: automations
  version: 1.2.0
  core: false                      # true solo en identity, organizations, authorization, audit
depends_on:
  required: [identity, organizations, crm]
  optional: [calendar, whatsapp]
permissions:
  - automations.read
  - automations.manage
events:
  publishes: [automation.executed, automation.failed]
  consumes: [conversation.created, deal.stage_changed]
tools:
  - automations.create_rule
  - automations.list_rules
nav:
  - { label: Automatizaciones, path: /automations, permission: automations.read }
widgets:
  - { id: automations.summary, permission: automations.read }
flags:
  key: module.automations
```

### Reglas

1. Un módulo solo importa de otro a través de su `contract.ts`. `dependency-cruiser`
   lo verifica en CI; una violación falla el PR.
2. El Module Registry lee los manifiestos al arrancar, construye el grafo, valida
   ciclos y colisiones de permisos y eventos, inicializa en orden topológico y
   expone `GET /health/modules`.
3. Dos interruptores. Plataforma (SuperAdmin): instalado, habilitado, kill-switch.
   Tenant (Admin): activado según plan y feature flag.
4. No se puede apagar un módulo del que otro activo depende como `required`. El
   registro bloquea y dice qué apagar primero.
5. Módulo apagado para un tenant: endpoints responden `MODULE_DISABLED` sin tocar
   datos; navegación y widgets desaparecen porque el frontend se arma desde
   `GET /me/modules`; sus tools no se registran para los agentes; sus jobs se
   saltan en workers. Apagar nunca borra. Desinstalar es acción aparte con
   exportación previa.
6. Eventos: outbox transaccional, consumidores idempotentes, el publicador nunca
   conoce al consumidor. Si nadie consume, no pasa nada.
7. Dependencias opcionales se resuelven con `capabilities.get('calendar')`. Si
   devuelve null, la función degrada: la acción no aparece, las reglas que la usan
   se pausan con aviso.
8. Test de combinación en CI: cada módulo arranca solo con sus `required`; la app
   arranca con todo apagado menos el núcleo.

### Nunca

- Importar un archivo interno de otro módulo.
- Consultar una tabla de otro módulo.
- Asumir que un módulo opcional existe.
- Poner en `core` algo que un tenant podría querer apagar.

---

## 6. Multi-tenancy y datos

```
Modelo        shared database, shared schema, tenant_id en toda tabla de negocio
Cerrojo 1     guard de tenant en la API (sección 7)
Cerrojo 2     Row Level Security en Postgres con SET app.tenant_id por conexión
Cache         claves prefijadas por tenant, siempre
Logs          tenant_id en todo log estructurado
Eventos       tenant_id en el sobre de todo evento
Evolución     shared → schema por tenant → base dedicada, solo por exigencia contractual
```

Migraciones por módulo, versionadas, aditivas. Renombrar o borrar columnas es una
migración en dos pasos con ventana de compatibilidad. Supabase PITR activo; prueba
de restore mensual documentada.

pgvector para la base de conocimiento de los agentes, con `tenant_id` en la tabla
de embeddings y RLS igual que el resto.

---

## 7. Autorización

Roles como paquetes de permisos, nunca como condición en código.

```
Roles base       SUPERADMIN · ADMIN · SUPERVISOR · USER
Roles custom     por tenant, componen permisos del catálogo
Permiso          <módulo>.<recurso>.<acción>   crm.contacts.update
Guard            @RequireModule('crm') + @RequirePermission('crm.contacts.update')
Objeto           verificación de dueño o equipo cuando el recurso lo exige
Service accounts API keys con scopes, mismos permisos, identidad propia en audit
Agentes          las tools pasan por el mismo guard con la identidad del usuario
```

```ts
// Correcto
@RequirePermission('crm.contacts.update')
async update(@Tenant() tenant, @Actor() actor, @Param('id') id, dto) { ... }

// Prohibido
if (user.role === 'ADMIN') { ... }
```

El catálogo de permisos se genera desde los manifiestos; no se escribe a mano.
El SuperAdmin es cross-tenant y cada acción suya queda en audit con
`actor.kind = superadmin`.

---

## 8. API

```
Estilo          REST, OpenAPI 3.1 generado desde código, publicado en /docs
Versión         /v1 en la ruta; cambios incompatibles abren /v2
Paginación      cursor, límite máximo 100
Filtro y orden  ?filter[status]=open&sort=-created_at
Idempotencia    header Idempotency-Key en todo POST que crea o cobra
Correlación     X-Request-Id entra o se genera; se propaga a logs, eventos, agentes
Rate limiting   por tenant y por API key, en Redis, con cabeceras estándar
Webhooks        salientes firmados HMAC, reintentos exponenciales, panel de entregas
Autenticación   JWT de Supabase Auth para usuarios · API key para integraciones
```

Formato de error, único en toda la plataforma:

```json
{
  "code": "CONTACT_NOT_FOUND",
  "message": "No encontramos ese contacto. Puede que se haya eliminado.",
  "requestId": "req_01J...",
  "details": []
}
```

Los mensajes siguen la voz de Pulso: qué pasó y qué hacer, sin "Error:", sin el
mensaje crudo del sistema.

---

## 9. Canales y WhatsApp

Puerto único para todos los canales:

```ts
interface ChannelProvider {
  kind: 'whatsapp' | 'webchat' | 'instagram' | 'messenger';
  send(msg: OutboundMessage): Promise<ProviderMessageId>;
  verifyWebhook(req): boolean;
  normalize(payload): InboundMessage[];
}
```

WhatsApp: adaptador Kapso hoy. El vocabulario es el de la Cloud API de Meta
(`phone_number_id`, `waba_id`, ids de mensaje, plantillas, ventana de 24 h) y esos
ids se guardan en nuestra base. Migrar a Tech Provider propio es cambiar el
adaptador, no el módulo. Kapso no guarda lógica de negocio: sus flows, agentes y
base gestionada no se usan.

Webchat propio en fase 1 (mismo inbox, mismo agente). Instagram y Messenger en
fase 2, por Meta Graph API, cuando funcionen igual de bien que WhatsApp.

Los webhooks entrantes verifican firma, encolan y responden en milisegundos.
Nunca se procesa dentro del webhook.

Conversaciones, contactos, asignaciones y estados viven en nuestro Postgres. Siempre.

---

## 10. Agentes de IA

Tres agentes, un solo runtime, todos observados en Langfuse.

| Agente | Qué hace | Cómo actúa |
|---|---|---|
| Configurador | Arma pipeline, campos, automatizaciones y plantillas a partir de una descripción del negocio, con plantillas por rubro | propone → muestra diff → el usuario confirma → aplica vía las mismas APIs de admin, auditado como `user via agent` |
| Copiloto | Sugiere respuesta, resume, detecta intención, califica, prepara la ficha, agenda, envía link de pago | el humano manda con un toque; modo autónomo por horario o por conversación, nunca por defecto |
| Conocimiento | RAG sobre documentos del tenant (catálogo, precios, FAQ) | pgvector con RLS, citas en la respuesta |

Reglas:

- Tools expuestas como MCP, registradas solo para módulos activos del tenant,
  ejecutadas con la identidad y permisos del usuario que conversa.
- Prompts versionados en Langfuse; ningún prompt crítico hardcodeado.
- Cada acción de la IA queda explicada en la ficha del contacto: qué hizo y por qué.
- Cuota de IA por tenant, visible en tiempo real, con tope configurable.
- Evaluación: dataset de regresión por agente, LLM-as-judge para correctness y
  tool selection, feedback humano desde la bandeja.
- Redacción de PII antes de enviar a Langfuse según política del tenant.

---

## 11. Integraciones

```
Google Calendar   OAuth incremental por usuario · push notifications · tool MCP agenda
Google Drive      OAuth incremental · adjuntar y leer documentos · tool MCP
Gmail             OAuth incremental · leer hilos relacionados a un contacto
Pagos             Webpay · Flow · Mercado Pago · link de pago por tool · webhook confirma
Webhooks salientes por tenant, firmados
```

Tokens OAuth cifrados en Secret Manager, nunca en la base. Scopes se piden cuando
el usuario activa la integración, no al registrarse. Sincronización por push, no
por polling. Cada integración es un módulo y expone sus tools como MCP interno.

---

## 12. Automatizaciones y colas

BullMQ sobre Redis. Colas separadas por naturaleza:

```
inbound        mensajes entrantes, prioridad alta
outbound       envíos, con rate limit por número
automations    reglas disparadas por eventos
sync           Calendar, Drive, Gmail
scheduled      recordatorios, seguimientos, plantillas programadas
agents         ejecuciones largas de IA
```

Motor de reglas: disparador (evento) + condiciones + acciones. Las acciones
disponibles se calculan desde `capabilities`; una regla cuya acción depende de un
módulo apagado se pausa con aviso, no falla.

---

## 13. Auditoría y privacidad

```
audit_log      append-only · sin UPDATE ni DELETE por rol de aplicación
campos         actor, actor_kind, tenant, action, resource, resource_id,
               timestamp, ip, user_agent, result, request_id, metadata
integridad     hash encadenado por tenant, verificable
retención      configurable por tenant, mínimo legal por defecto
búsqueda       por tenant, actor, acción, recurso, IP, fecha, resultado
exportación    CSV y JSON, firmada
```

Privacidad: minimización de PII en logs y trazas, redacción antes de Langfuse,
borrado por solicitud del titular con registro de la solicitud, exportación total
del tenant en un clic. Ley 21.719 como referencia legal; ver sección 19.

---

## 14. Observabilidad

```
Sentry          errores en web, admin, api, workers, agents
OpenTelemetry   trazas, métricas y logs de plataforma → Grafana Cloud
Langfuse        trazas LLM, generaciones, tool calls, tokens, costo, evaluaciones
Correlación     mismo trace_id desde el navegador hasta la tool y la base
```

Trazas Langfuse etiquetadas con `tenant_id`, `user_id`, `conversation_id`,
`agent_id`, `session_id`, `request_id`. OpenTelemetry no duplica lo que Langfuse
registra: plataforma en uno, IA en el otro.

Alertas mínimas desde el día uno: error rate de API, latencia p95, fallos de
webhook, cola atascada, costo de IA por tenant fuera de rango.

---

## 15. Infraestructura y entornos

```
Ambientes      local (compose) · dev · staging · prod
GCP            un proyecto por ambiente, Terraform desde el mismo código
Cloud Run      tres servicios (api, workers, agents) desde una imagen
Redis          Memorystore
Storage        Cloud Storage para adjuntos y exportaciones
Secrets        Secret Manager, montados como env en Cloud Run
Borde          Cloudflare delante de Vercel (web, admin) y de Cloud Run (api)
Backups        Supabase PITR · restore probado mensualmente · RPO 5 min · RTO 1 h
```

Kubernetes: el Helm chart existe y se prueba en CI contra kind, pero no se
despliega. Condición para activarlo: cliente que exija aislamiento de red o
volumen que Cloud Run no cubra. Se documenta en ADR.

---

## 16. DevSecOps y GitHub

Pipeline en cada PR, en este orden, todo bloqueante:

```
lint → typecheck → dependency-cruiser → unit → integration (Postgres + Redis en CI)
→ contract (OpenAPI vs implementación) → module-combinations → CodeQL → Gitleaks
→ Trivy (imagen) → Checkov (Terraform) → build → deploy a dev
```

Staging se despliega desde `main`; producción con aprobación manual en el
environment de GitHub. Semgrep y OWASP ZAP se agregan cuando haya usuarios reales,
no antes.

Flujo de trabajo:

```
Issue → rama feat/<issue>-<slug> → PR con plantilla → checks → review → squash
→ release con changelog (conventional commits, semver) → deploy
```

CODEOWNERS por módulo. Branch protection en `main`. Dependabot semanal.

---

## 17. SuperAdmin

Aplicación aparte (`apps/admin`), misma API, permisos `platform.*`.

```
Plataforma     tenants, usuarios, actividad, errores, uptime, consumo, storage
Tenants        crear, suspender, activar; módulos, agentes, integraciones,
               API keys, plan, uso, seguridad, audit
Módulos        instalar, habilitar, kill-switch, versión, dependencias, health
Centro de IA   ejecuciones, éxito, latencia, tokens, costo por tenant / agente /
               modelo / día, evaluaciones, navegación tenant → conversación →
               ejecución → trace → generación → tool call
Seguridad      logins fallidos, IPs bloqueadas, violaciones de permiso, abuso de
               API, fallos de webhook
Audit          explorador con todos los filtros de la sección 13
Salud          api, workers, agents, Postgres, Redis, colas, Kapso, Google, Gemini
```

Los datos del centro de IA se leen desde Langfuse por API y se cachean; no se
duplican en nuestra base salvo los agregados por tenant para billing.

---

## 18. Interfaz: sistema Pulso

IAxTi usa el sistema de diseño Pulso de VoxTi Labs tal cual está en su documento.
Lo que sigue es lo que Claude Code debe aplicar sin releerlo cada vez.

### Instalación en el monorepo

- `packages/ui/pulso-tokens.css` con los dos bloques de tokens (día y noche).
  Se importa una vez en `apps/web` y `apps/admin`.
- Modo con `<html data-mode="dia">` o `"noche"`. Inicial según
  `prefers-color-scheme`; el usuario lo cambia y se persiste por usuario.
- Tailwind apunta los colores a las variables (`bg`, `raised`, `rest`, `line`,
  `ink`, `body`, `muted`, `action`) y usa `darkMode: ['selector', '[data-mode="noche"]']`.
  Nunca variantes `dark:` en componentes.
- shadcn/ui se tematiza en `packages/ui`: radios (botón 999, campo 14, tarjeta 22),
  alto de control 46 px, sin sombras, fuentes Outfit / Inter / JetBrains Mono.

### Reglas que el código debe cumplir

- Ningún componente sabe en qué modo está. Ningún hex suelto en componentes.
- Tres superficies: `--bg`, `--bg-raised`, `--bg-rest`. Nada más.
- Un solo botón primario por vista.
- Montos, UF, RUT, fechas, plazos e identificadores en JetBrains Mono.
- Outfit solo en titulares. Mono nunca en prosa.
- Etiquetas: fondo `--{rol}-soft`, texto `--{rol}-text`. El color nunca es el único
  portador de significado.
- Avisos: qué pasó y qué hacer, en una frase. Estados vacíos: qué va a aparecer y
  la acción que lo provoca.
- Foco visible `outline: 2px solid var(--action); outline-offset: 2px`.
- Funciona a 360 px sin scroll horizontal. Respeta `prefers-reduced-motion`.

### Aplicado al producto

- La bandeja es la pantalla principal: lista de conversaciones a la izquierda
  (`--bg-raised`), conversación al centro (`--bg`), ficha del contacto a la derecha
  (`--bg-raised`). En celular, tres pantallas apiladas.
- Las sugerencias del copiloto viven en un aviso `action-soft` sobre el campo de
  respuesta, con un solo botón primario: "Enviar sugerencia".
- Las acciones de la IA en la ficha se muestran como filas con rótulo mono
  ("AGENDÓ", "ENVIÓ LINK") y la explicación en `--text-body`.
- El configurador muestra el "antes" y el "después" con el dispositivo de marca de
  Pulso: a la izquierda cómo trabaja hoy el negocio, a la derecha el CRM propuesto.
- Costos de Meta e IA en mono, siempre visibles en la configuración del tenant.

### Marca

El isotipo y el lockup de VoxTi Labs se usan en el SuperAdmin y en el pie de la
app cliente ("un producto de VoxTi Labs"), con `voxti-tokens.svg` inline y por
sobre los tamaños mínimos. IAxTi necesita su propia marca; hasta que exista, el
nombre se escribe como texto en Outfit 800 y no se trata como logo.

### Antipatrones heredados de Pulso, sin excepción

Gradientes, sombras, morado y violeta, verde como principal, blanco puro en texto
nocturno, negro puro de fondo, glassmorphism, emoji en interfaz, iconos de cohete
o rayo o cerebro, contadores animados, copy de relleno, métricas inventadas.

---

## 19. Compliance

Tres cosas distintas que no se confunden:

```
Preparación técnica   lo que el código hace: cifrado, RLS, audit, retención,
                      borrado, control de acceso, backups, redacción de PII
Certificación formal  ISO 27001 / 27701 / 42001: políticas, responsable, evidencia,
                      auditoría externa. Meses. No es código.
Cumplimiento legal    Ley 21.719: base de licitud, derechos del titular, contratos
                      de tratamiento con cada cliente, notificación de brechas
```

`COMPLIANCE_BASELINE.md` mantiene la matriz:

```
Control · ISO 27001 · ISO 27701 · ISO 42001 · OWASP ASVS · Ley 21.719
· Implementación · Tipo (técnico / organizacional / legal / contractual) · Estado
```

Cada feature nueva que toque datos personales o IA actualiza su fila. Nunca se
escribe "cumple ISO" en material comercial ni en el producto.

---

## 20. Roadmap

```
Fase 0   Discovery            este documento, ADRs, CLAUDE.md, .claude/, issues
Fase 1   Fundación   sem 1–3  monorepo, registro de módulos, núcleo, RLS, auth,
                              audit, OpenAPI, CI completo, Cloud Run + Terraform
Fase 2   CRM núcleo  sem 4–7  contactos, pipelines, campos custom, actividades,
                              bandeja, web y admin con Pulso
Fase 3   IA + WA     sem 8–11 Kapso, webchat, copiloto, configurador, Langfuse,
                              cuota de IA. Demo vendible al final de esta fase.
Fase 4   Google      sem 12–14 Calendar, Drive, Gmail, pagos
Fase 5   Crecimiento           SuperAdmin completo, billing, analytics,
                              automatizaciones avanzadas, Instagram y Messenger
Fase 6   Hardening              load testing, DR probado, matriz de compliance
                              completa, Tech Provider si el volumen lo justifica
```

Al terminar la fase 3 se sale a vender. La fase 5 se ordena con feedback real.

---

## 21. Claude Code

### CLAUDE.md

Contiene, en forma operativa: los principios de la sección 2, las reglas de
módulos de la 5, el patrón de autorización de la 7, el formato de error de la 8,
las reglas de interfaz de la 18, los comandos de desarrollo, y la instrucción de
leer `docs/SPEC.md` y el ADR correspondiente antes de tocar un área.

### .claude/

```
rules/       arquitectura · módulos · seguridad · testing · api · db · git · ui-pulso
commands/    /new-module · /new-adr · /security-review · /module-check · /ui-check
agents/      reviewer-arquitectura · reviewer-seguridad · reviewer-pulso
hooks/       pre-commit: lint, typecheck, dependency-cruiser, gitleaks
skills/      iaxti-module · iaxti-permissions · iaxti-channel-provider
             · iaxti-compliance · iaxti-pulso
```

### Skills externas (instalar antes de empezar)

Oficiales de Anthropic, marketplace `@claude-plugins-official`: `skill-creator`,
`mcp-builder`, `frontend-design`, `webapp-testing`.

De Matt Pocock, repo `mattpocock/skills`, en el marketplace oficial:
`setup-matt-pocock-skills`, `grill-me`, `wayfinder`, `to-prd`, `to-issues`,
`triage`, `handoff`, `zoom-out`, `improve-codebase-architecture`, `tdd`,
`domain-model`.

```bash
npx skills@latest add mattpocock/skills \
  --skill setup-matt-pocock-skills --skill grill-me --skill wayfinder \
  --skill to-prd --skill to-issues --skill triage --skill handoff \
  --skill zoom-out --skill improve-codebase-architecture --skill tdd \
  --skill domain-model -y
```

```
/plugin install skill-creator@claude-plugins-official
/plugin install mcp-builder@claude-plugins-official
/plugin install frontend-design@claude-plugins-official
/plugin install webapp-testing@claude-plugins-official
```

Verifica los nombres con `/plugin` antes de instalar. Las cinco skills `iaxti-*`
no existen y se crean con `skill-creator` en la fase 0.

### Disciplina de contexto

- `/wayfinder` al inicio de cada fase para el mapa de decisiones.
- `/handoff` al cerrar cada sesión larga; la siguiente sesión empieza leyendo el
  handoff, no el historial.
- `/zoom-out` antes de cualquier cambio que toque más de un módulo.

---

## 22. Fase 0: lo que haces ahora

No escribas código de producto.

1. `/setup-matt-pocock-skills` (issue tracker: GitHub).
2. `/grill-me` sobre este documento: pregúntame lo que necesites cerrar, con tu
   respuesta recomendada en cada pregunta.
3. Genera `docs/ARCHITECTURE.md` con Mermaid: infraestructura, sistema de módulos,
   permisos, flujo de un mensaje de WhatsApp de punta a punta, flujo del
   configurador.
4. Genera `docs/adr/0001` a `0009`: stack TypeScript · Supabase como datos e
   identidad · Cloud Run antes que GKE · BullMQ antes que Pub/Sub · Kapso ahora y
   Tech Provider después · Langfuse + OpenTelemetry · sistema de módulos · modelo
   de autorización · Pulso como sistema de diseño.
5. Genera `docs/SECURITY_BASELINE.md`, `docs/COMPLIANCE_BASELINE.md` con la matriz
   de la sección 19, e `docs/IMPLEMENTATION_PLAN.md` por semanas según la 20.
6. Genera `CLAUDE.md` y `.claude/` según la sección 21, y crea las cinco skills
   `iaxti-*` con `skill-creator`.
7. `/to-issues` sobre el plan de la fase 1, como tracer bullets con dependencias.
8. `/handoff` y detente. Espera mi aprobación antes de la fase 1.

---

## 23. Antes de cualquier PR

1. ¿El cambio vive en un solo módulo o cruza por `contract.ts` y eventos?
2. ¿Todo endpoint nuevo tiene `@RequireModule`, `@RequirePermission` y OpenAPI?
3. ¿Toda mutación importante escribe en `audit_log`?
4. ¿Hay `tenant_id` en toda tabla nueva y política RLS que lo use?
5. ¿La migración es aditiva y versionada?
6. ¿Hay tests, incluido el de combinación de módulos si tocaste el manifiesto?
7. ¿Alguna tool nueva pasa por el guard con la identidad del usuario?
8. ¿Algún hex suelto, sombra, gradiente o emoji en la interfaz? Búscalo.
9. ¿Se ve bien en día y en noche, a 360 px, con el foco visible?
10. ¿Algún secret, token o URL interna en el diff?
11. ¿El ADR existe si la decisión es importante? ¿La matriz de compliance está al día?
12. ¿El PR referencia su issue y el título sigue conventional commits?
