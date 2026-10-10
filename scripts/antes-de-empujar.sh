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
# Cuántos fallos fueron SOLO de tiempo (#776).
#
# Cuatro guardas de este repo escanean el repositorio entero en menos de un
# segundo con la máquina libre, y pasan de los 5 s de vitest cuando está
# cargada: medido, entre 8 y 15 veces más lento con catorce agentes encima.
# Ese rojo no habla del cambio — y un rojo que no habla del cambio enseña a
# ignorar el rojo, que es lo que este script existe para evitar.
#
# No se sube ningún presupuesto ni se afloja ninguna guarda: se dice la verdad
# sobre qué pasó, y la decisión de volver a correrlo queda en quien lo lee.
solo_tiempo=0
paso() {
  local nombre="$1"; shift
  printf '\n\033[1m── %s\033[0m\n' "$nombre"
  # `tee` y no capturar: la salida sigue saliendo en vivo —una corrida de tests
  # son diez minutos y hay que poder ver por dónde va— y además queda guardada
  # para poder mirarla después.
  local log
  log=$(mktemp)
  if "$@" 2>&1 | tee "$log"; then
    printf '\033[32m   ok\033[0m\n'
  else
    printf '\033[31m   FALLÓ\033[0m\n'
    fallos+=("$nombre")
    # Todas las causas del paso son timeouts: ninguna aserción se rompió.
    # Vitest imprime una línea `→ …` por fallo, así que si TODAS las flechas
    # son de tiempo, no hay nada roto que arreglar.
    local flechas timeouts
    flechas=$(grep -c '→ ' "$log" || true)
    timeouts=$(grep -c '→ Test timed out in' "$log" || true)
    if [ "$flechas" -gt 0 ] && [ "$flechas" = "$timeouts" ]; then
      solo_tiempo=$((solo_tiempo + 1))
    fi
  fi
  rm -f "$log"
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
# `--continue` y no es un detalle: sin él, turbo corta en el PRIMER paquete que
# falla y los demás no corren. Pasó con #700 — un flake de `integrations` tapó
# una guarda de `apps/api` que CI sí cazó, y la corrida de doce minutos se gastó
# en algo que este script ya tenía que haber dicho.
paso 'tests'       pnpm turbo test --concurrency=1 --continue "$@"

# Estas tres van FUERA de turbo, igual que en CI, y por el mismo motivo: su
# entrada es el repo entero, así que turbo las sirve desde caché justo en el PR
# que las necesitaba.
paso 'guardas de esquema (packages/db)'  pnpm --filter @iaxti/db exec vitest run
paso 'guardas de core'                   pnpm --filter @iaxti/core exec vitest run

# El catálogo del Agente General se genera del OpenAPI de la app levantada: una
# ruta nueva lo deja viejo y la guarda falla en CI. Acá se regenera y el diff
# queda a la vista antes del commit.
paso 'catálogo de herramientas'          pnpm catalogo

# Las migraciones sobre una base NUEVA (#738). Local la base ya tiene todas las
# tablas, así que una migración que referencia la tabla de otro módulo pasa verde
# acá y falla en CI: el runner aplica en orden topológico de dependencias.
paso 'migraciones en base virgen'       node scripts/migraciones-en-base-virgen.mjs

# Los dos trinquetes con lista base: avisan si hay que bajar la marca.
paso 'exports sin consumidor'            node scripts/exports-sin-consumidor.mjs
paso 'columnas sin lector'               node scripts/columnas-sin-lector.mjs

printf '\n'
if [ ${#fallos[@]} -eq 0 ]; then
  printf '\033[32mTodo verde. Si cambió el catálogo o una lista base, revisa el diff y commitéalo.\033[0m\n'
  exit 0
fi
printf '\033[31mFalló: %s\033[0m\n' "${fallos[*]}"
if [ "$solo_tiempo" = "${#fallos[@]}" ]; then
  printf '\033[33mOJO: todos los fallos son TIMEOUTS, ninguna aserción se rompió.\033[0m\n'
  printf 'Estas guardas escanean el repo entero en menos de un segundo con la máquina libre\n'
  printf 'y pasan de los 5 s de vitest cuando está cargada (#776). Si tienes algo pesado\n'
  printf 'corriendo —el e2e, un build de Docker, agentes— esto no dice nada de tu cambio:\n'
  printf 'vuelve a correrlo con la máquina tranquila antes de tocar el código.\n'
  exit 1
fi
printf 'Arregla esto antes de empujar: en CI son doce minutos por corrida.\n'
exit 1
