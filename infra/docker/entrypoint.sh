#!/bin/sh
# Un contenedor, cinco servicios: SERVICE decide el entrypoint (12-factor).
set -e
export HOSTNAME=0.0.0.0
export PORT="${PORT:-3000}"

case "${SERVICE:?Define SERVICE: api | workers | agents | web | admin}" in
  api)     exec node /app/apps/api/dist/main.js ;;
  workers) exec node /app/apps/workers/dist/main.js ;;
  agents)  exec node /app/apps/agents/dist/main.js ;;
  web)     cd /app/standalone-web/apps/web && exec node server.js ;;
  admin)   cd /app/standalone-admin/apps/admin && exec node server.js ;;
  *) echo "SERVICE desconocido: ${SERVICE}" >&2; exit 1 ;;
esac
