#!/usr/bin/env bash
# Etiquetas del método de Issues (SPEC §35). Idempotente (--force).
# Uso: GH_TOKEN=... bash scripts/github-labels.sh [owner/repo]
set -euo pipefail
REPO="${1:-voxtilabs/IAxTi}"

l() { gh label create "$1" -R "$REPO" --color "$2" --description "$3" --force >/dev/null && echo "label $1"; }

l "type:feature"  "1D76DB" "Funcionalidad nueva"
l "type:bug"      "D73A4A" "Algo no funciona"
l "type:chore"    "6E7781" "Mantenimiento o tooling"
l "type:adr"      "8250DF" "Requiere o documenta una decisión de arquitectura"
l "type:spike"    "BFD4F2" "Investigación con tiempo acotado"
l "type:security" "B60205" "Seguridad"

for m in identity organizations authorization audit crm conversations channels \
         whatsapp webchat agents knowledge automations calendar payments \
         integrations analytics billing notifications platform; do
  l "module:$m" "0E8A16" "Módulo $m"
done
l "module:core"  "044289" "packages/core"
l "module:infra" "5319E7" "Infraestructura, CI/CD, Dokploy, Cloudflare"

for p in 1 2 3 4 5 6; do l "phase:$p" "FBCA04" "Fase $p del roadmap"; done

l "priority:p0" "B60205" "Bloquea"
l "priority:p1" "D93F0B" "Esta semana"
l "priority:p2" "FBCA04" "Este mes"
l "priority:p3" "C2E0C6" "Cuando se pueda"

l "size:xs" "C5DEF5" "< 2 h"
l "size:s"  "C5DEF5" "Medio día"
l "size:m"  "C5DEF5" "Un día"
l "size:l"  "C5DEF5" "2-3 días: se parte, no se toma"

l "status:blocked" "E99695" "Bloqueado; el issue que bloquea va en el cuerpo"
l "needs:decision" "D876E3" "Requiere ADR o respuesta del dueño"
echo "Listo."
