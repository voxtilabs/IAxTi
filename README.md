# IAxTi

CRM conversacional para pymes chilenas que venden por WhatsApp. Se arma solo
con IA, sugiere respuestas, agenda en Google Calendar y cobra con links de
pago desde el chat. Un producto de VoxTi Labs.

- **Fuente de verdad:** [`docs/SPEC.md`](docs/SPEC.md) · decisiones en
  [`docs/adr/`](docs/adr/) · plan en
  [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- **Método:** nada se construye sin Issue. Milestones por fase; épicas
  #19–#23 como paraguas. Reglas operativas en [`CLAUDE.md`](CLAUDE.md) y
  `.claude/rules/`.

## Desarrollo

```bash
pnpm install          # monorepo completo (pnpm 12 + Turborepo)
pnpm build            # compila los 14 workspaces
pnpm typecheck        # tipos
pnpm lint             # ESLint 9
docker compose up     # postgres + redis + web/admin/api/workers/agents
```

Una sola imagen Docker con cinco entrypoints (`SERVICE=api|workers|agents|web|admin`).
CI en `.github/workflows/ci.yml`; build → GHCR → deploy staging vía Dokploy
(`.github/workflows/build.yml`, `deploy-staging.yml`).

Activa el pre-commit del repo (lint, typecheck, dependency-cruiser, gitleaks):

```bash
git config core.hooksPath .claude/hooks
```

## Skills para Claude Code

Las skills del proyecto viven en `.claude/skills/` (iaxti-module,
iaxti-permissions, iaxti-channel-provider, iaxti-compliance, iaxti-pulso,
iaxti-business-rules, iaxti-context) y se cargan solas.

Externas, instalar una vez por máquina:

```bash
# Método de trabajo (Matt Pocock): grill-me, wayfinder, to-issues, triage,
# handoff, zoom-out, tdd, domain-model...
npx skills@latest add mattpocock/skills \
  --skill setup-matt-pocock-skills --skill grill-me --skill wayfinder \
  --skill to-prd --skill to-issues --skill triage --skill handoff \
  --skill zoom-out --skill improve-codebase-architecture --skill tdd \
  --skill domain-model -y

# WhatsApp/Kapso: usar SOLO integrate-whatsapp y observe-whatsapp
# (automate-whatsapp NO: la lógica de negocio no vive en Kapso, SPEC §12)
npx skills add gokapso/agent-skills
```

Dentro de Claude Code (verifica nombres con `/plugin`):

```
/plugin install skill-creator@claude-plugins-official
/plugin install frontend-design@claude-plugins-official
/plugin install webapp-testing@claude-plugins-official
```
