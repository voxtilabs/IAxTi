# IAxTi — reglas operativas para Claude Code

CRM conversacional SaaS multi-tenant para pymes chilenas, WhatsApp primero.
Fuente de verdad: `docs/SPEC.md`. Antes de tocar un área, lee su sección del
SPEC y su ADR en `docs/adr/`. Las reglas detalladas por tema están en
`.claude/rules/`. Nada se construye sin Issue.

## Principios (si una tarea los contradice, la tarea está mal planteada)

1. Monolito modular; los módulos se apagan por tenant sin romper nada.
2. Sin lógica de negocio en controllers. Sin acceso directo entre módulos:
   solo `contract.ts` y eventos.
3. Toda operación respeta el tenant context; toda mutación importante se
   audita en la misma transacción.
4. El LLM nunca toca la base: solo tools autorizadas con la identidad del
   usuario. La IA nunca inventa precio, stock, plazo ni compromiso.
5. Toda API pública tiene OpenAPI; toda funcionalidad nueva tiene tests; toda
   migración es aditiva y versionada.
6. Nada de secrets en Git. Nada de hex suelto en la interfaz.
7. Nada se borra desde la interfaz: se archiva (retención: SPEC §39).
8. No se afirma cumplimiento ISO ni legal; la arquitectura es auditable.
9. Decisión importante → ADR (`/new-adr`). Si una decisión del SPEC te parece
   mala, contradice con argumentos antes de implementar.

## Patrones obligatorios

```ts
// Autorización: siempre así, nunca if (user.role === '...')
@RequireModule('crm')
@RequirePermission('crm.contacts.update')
async update(@Tenant() tenant, @Actor() actor, @Param('id') id, dto) { ... }
```

```json
// Error único en toda la plataforma, voz Pulso (qué pasó y qué hacer)
{ "code": "CONTACT_NOT_FOUND", "message": "No encontramos ese contacto. Puede que se haya eliminado.", "requestId": "req_...", "details": [] }
```

- Módulo nuevo: `/new-module` (manifiesto, contract, migración, tests).
- Eventos por outbox; consumidores idempotentes; `tenant_id` en el sobre.
- Dependencias opcionales por `capabilities.get()`; null degrada, no rompe.
- Webhooks: verificar firma, encolar, responder < 1 s; idempotencia por id.
- Horario de silencio, ventana de 24 h y consentimiento aplican a TODO envío
  iniciado por el negocio (`.claude/rules/negocio.md`).

## Interfaz

Sistema Pulso (`.claude/rules/ui-pulso.md`): tokens en `packages/ui`, modo
día/noche por `data-mode`, sin `dark:`, sin hex suelto ni emoji. Pulso Vivo (ADR-0021) permite material jelly,
relieves y gradientes ambientales solo desde tokens y la capa compartida; mono para montos/RUT/fechas/ids, un primario por vista,
360 px, foco visible. Verificar con `/ui-check`.

Pulso son TOKENS; shadcn son los COMPONENTES, y leen variables CSS: no
compiten, se enchufan. Antes de tocar una pantalla, las skills del repo:
`iaxti-pulso` (cómo se aplica acá), `shadcn-ui` (traer y configurar
componentes) y `tailwind-design-system` (el nivel de sistema). Las dos
últimas son de terceros, con su origen y su hash en `skills-lock.json`; se
restauran con `npx skills experimental_install`.

Para correo (#55) están las de Resend, también de terceros y en el mismo
lock: `resend` (la API), `email-best-practices` (SPF/DKIM/DMARC, rebotes,
transaccional vs marketing) y `react-email` (plantillas). El remitente va
SIEMPRE en `SMTP_FROM` con un dominio verificado — el usuario SMTP de
Resend es literalmente `resend` y no es una dirección.

## Desarrollo

```
pnpm install            # instala todo el monorepo
pnpm turbo build        # compila
pnpm turbo typecheck    # tipos
pnpm turbo lint         # lint
docker compose up       # local: postgres + redis + los 5 servicios
pnpm seed               # tenant demo con ADMIN y USER (idempotente)
```

## Flujo de trabajo

Issue → rama `feat|fix|chore/<n>-<slug>` desde `staging` → PR con
"Closes #n" contra `staging` y el checklist de `.claude/rules/git.md` →
checks verdes → squash a `staging` → staging automático → verificación →
promoción a `main` con `--ff-only` → tag `vX.Y.Z` → prod (aprobación
manual). Por qué `staging` y no main: ADR-0019. Conventional
commits; el changelog sale de los títulos de PR.

Antes de terminar un PR pasa `/module-check`, `/security-review` si tocaste
auth/datos/tools, `/rule-check` si tocaste envíos o IA, y `/ui-check` si hay
interfaz.
