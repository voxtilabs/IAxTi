#!/usr/bin/env bash
# Lo que CI va a correr, acá, antes de empujar.
#
# Por qué existe: cada corrida de CI son ~12 minutos, y esta semana la mitad
# del tiempo de cada issue se fue en descubrir ALLÁ cosas que la máquina local
# podía decir en dos minutos. Tres PRs necesitaron dos y tres corridas, todas
# por guardas del repo que no corrí antes: el catálogo del Agente General, la
# validación en esquemas, el escáner de RLS, los exports sin consumidor.
#
# El orden es el de CI a propósito: falla por lo mismo y en el mismo punto.
# No reemplaza a CI —ahí corren Semgrep, el e2e de Playwright y los evals con
# su secret— pero saca del camino todo lo que sí se puede ver acá.
#
# Uso:  scripts/antes-de-empujar.sh [filtros de turbo]
#   sin argumentos: todo el monorepo (lento, pero es lo que corre CI)
#   con filtros:    scripts/antes-de-empujar.sh --filter=@iaxti/module-crm
set -uo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL="${DATABASE_URL:-postgres://iaxti:iaxti@127.0.0.1:5432/iaxti}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

fallos=()
paso() {
  local nombre="$1"; shift
  printf '\n\033[1m── %s\033[0m\n' "$nombre"
  if "$@"; then
    printf '\033[32m   ok\033[0m\n'
  else
    printf '\033[31m   FALLÓ\033[0m\n'
    fallos+=("$nombre")
  fi
}

# El orden de CI: lint y typecheck primero porque son los más rápidos en
# contestar, y build antes de los tests porque el e2e corre contra el build.
#
# `lint` y `depcruise` van SIN filtro siempre, y no es un olvido: el primero es
# `eslint .` —no entiende los filtros de turbo y sale con código 2 si se le
# pasan— y el segundo cruza el repo entero por definición, que es de lo que se
# trata una guarda de fronteras entre módulos.
paso 'lint'        pnpm lint
paso 'depcruise'   pnpm depcruise
paso 'typecheck'   pnpm typecheck "$@"
paso 'build'       pnpm build "$@"
paso 'tests'       pnpm turbo test --concurrency=1 "$@"

# Estas tres van FUERA de turbo, igual que en CI, y por el mismo motivo: su
# entrada es el repo entero, así que turbo las sirve desde caché justo en el PR
# que las necesitaba.
paso 'guardas de esquema (packages/db)'  pnpm --filter @iaxti/db exec vitest run
paso 'guardas de core'                   pnpm --filter @iaxti/core exec vitest run

# El catálogo del Agente General se genera del OpenAPI de la app levantada: una
# ruta nueva lo deja viejo y la guarda falla en CI. Acá se regenera y el diff
# queda a la vista antes del commit.
paso 'catálogo de herramientas'          pnpm catalogo

# Los dos trinquetes con lista base: avisan si hay que bajar la marca.
paso 'exports sin consumidor'            node scripts/exports-sin-consumidor.mjs
paso 'columnas sin lector'               node scripts/columnas-sin-lector.mjs

printf '\n'
if [ ${#fallos[@]} -eq 0 ]; then
  printf '\033[32mTodo verde. Si cambió el catálogo o una lista base, revisa el diff y commitéalo.\033[0m\n'
  exit 0
fi
printf '\033[31mFalló: %s\033[0m\n' "${fallos[*]}"
printf 'Arregla esto antes de empujar: en CI son doce minutos por corrida.\n'
exit 1
