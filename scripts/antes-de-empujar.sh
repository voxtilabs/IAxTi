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
#   sin argumentos: solo los paquetes que esta rama cambió (ver abajo)
#   TODO=1:         el monorepo entero, como CI con caché frío
#   con filtros:    scripts/antes-de-empujar.sh --filter=@iaxti/module-crm
set -uo pipefail
cd "$(dirname "$0")/.."

# Solo los paquetes que esta rama toca, y por qué eso no es aflojar la guarda.
#
# Medido el 12-10 sobre los diez commits anteriores: nueve tocaban **4
# paquetes o menos** de 30, y uno los 30. O sea que correr el monorepo entero
# en cada preflight gastaba ~10 minutos por cambio para re-verificar 26
# paquetes que el cambio no puede haber roto —y eso es lo que turbo sabe
# calcular solo—. Seis preflights de ese día: una hora, duplicando lo que CI
# iba a hacer igual.
#
# Esto NO reemplaza a CI, que sigue corriendo todo con su caché: lo que se
# saca de acá es el trabajo que la máquina local repite por nada.
#
# Dos cosas se quedan sin filtro a propósito, y están más abajo con su motivo:
# `lint` y `depcruise` miran el repo entero por definición, igual que las tres
# guardas del final.
#
# Si el cálculo falla —una rama sin upstream, un `origin/staging` que no está—
# se corre TODO. Fallar hacia correr de más es la única dirección segura:
# fallar hacia correr de menos sería una guarda que se apaga sola.
if [ "$#" -eq 0 ] && [ "${TODO:-0}" != "1" ]; then
  base="${BASE:-origin/staging}"
  if git rev-parse --verify --quiet "$base" >/dev/null; then
    afectados=$(npx turbo ls --filter="...[$base]" 2>/dev/null | grep -cE "packages/|apps/" || true)
    total=$(npx turbo ls 2>/dev/null | grep -cE "packages/|apps/" || true)
    if [ "${afectados:-0}" -gt 0 ] && [ "${afectados:-0}" -lt "${total:-0}" ]; then
      set -- "--filter=...[$base]"
      printf '\033[1mSolo lo que esta rama cambió: %s de %s paquetes.\033[0m ' "$afectados" "$total"
      printf 'Con TODO=1 corre el monorepo entero.\n'
    else
      printf '\033[1mEsta rama afecta %s de %s paquetes: se corre todo.\033[0m\n' \
        "${afectados:-?}" "${total:-?}"
    fi
  else
    printf '\033[33mNo encuentro %s, así que se corre todo.\033[0m\n' "$base"
  fi
fi

# Base y Redis DE PRUEBAS, no los del stack de desarrollo (#1027).
#
# Cuando las suites corrían contra la base de `docker compose`, tres cosas se
# rompían juntas: los tests del seed resembraban el tenant demo (la URL del
# webchat moría en cada preflight), los workers vivos se robaban los jobs de
# BullMQ de los tests, y procesaban su outbox dejando `processed_events` que
# rompían por FK la limpieza de once suites. El remedio era detener
# contenedores a mano y destrabar con un DELETE — de memoria, cada vez.
#
# Quien exporte sus propias URLs sigue mandando (CI lo hace); la base de
# pruebas se crea si falta y cada suite la migra sola en su beforeAll.
export DATABASE_URL="${DATABASE_URL:-postgres://iaxti:iaxti@127.0.0.1:5432/iaxti_pruebas}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379/1}"
if [[ "$DATABASE_URL" == *"/iaxti_pruebas" ]]; then
  node -e '
    // pnpm no iza pg a la raíz: se resuelve a través de packages/db, que lo declara.
    const { Client } = require(require.resolve("pg", { paths: ["packages/db"] }));
    const admin = new Client({ connectionString: process.env.DATABASE_URL.replace(/\/iaxti_pruebas$/, "/iaxti") });
    admin.connect()
      .then(() => admin.query("SELECT 1 FROM pg_database WHERE datname = $1", ["iaxti_pruebas"]))
      .then((r) => (r.rowCount ? null : admin.query("CREATE DATABASE iaxti_pruebas")))
      .then(() => admin.end())
      .catch((e) => { console.error("No pude preparar iaxti_pruebas:", e.message); process.exit(1); });
  ' || exit 1
fi

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

# Esta NO es un trinquete: es cero y se queda en cero. Un `fetch` que no mira
# qué contestó el servidor no tiene versión aceptable — a diferencia de una
# lista sin estado vacío, que es fea pero funciona.
paso 'respuestas sin mirar'              node scripts/respuestas-sin-mirar.mjs
paso 'el negocio se sigue'               node scripts/el-negocio-se-sigue.mjs

# Los trinquetes con lista base: avisan si hay que bajar la marca.
paso 'exports sin consumidor'            node scripts/exports-sin-consumidor.mjs
paso 'columnas sin lector'               node scripts/columnas-sin-lector.mjs
# Los cruces de tablas entre módulos (#784). La guarda de verdad vive en
# `packages/core/tests` y ya corrió arriba; esto está acá por lo mismo que las
# otras dos listas base: cuando el trinquete manda a bajar la marca, lo que hace
# falta es el comando que la baja, no una edición a mano del .txt.
paso 'consultas entre módulos'           node scripts/consultas-entre-modulos.mjs
paso 'listas sin estado vacío'           node scripts/listas-sin-vacio.mjs
paso 'avisos sin rastro'                 node scripts/avisos-sin-rastro.mjs

# El e2e de la bandeja, SOLO si tocaste lo que lo afecta (#1094).
#
# Por qué existe: el 27/10 #1076 arregló el aviso de retención y #1078 lo volvió
# INVISIBLE —metió `zonaDelTenant`, que degrada con savepoints, adentro de un
# `Promise.all` que comparte un solo PoolClient—. Los dos PRs pasaron este
# script Y CI. El defecto apareció tres PRs después, corriendo el e2e completo
# para medir un PR de dependencias que no tenía nada que ver.
#
# El e2e es lo ÚNICO que ejercita el arranque del panel con sus piezas en
# paralelo, contra una base de verdad y por HTTP. Ninguna suite de unidad monta
# eso, y el arranque es la primera petición de cada sesión: un defecto ahí lo ve
# todo el mundo. Este se caía callado, porque cada pieza atrapa su fallo para no
# tumbar la pantalla.
#
# Cuesta 27 s, no 3 minutos: el build ya está pagado arriba —y su comentario
# dice justamente «build antes de los tests porque el e2e corre contra el
# build»—. Medido: 0,6 s de build con caché caliente, 17,4 s de pruebas.
#
# Filtrado a `bandeja` y no completo: las 113 son 2,6 min y este script existe
# para ser corrido siempre. Las cuatro de la bandeja son las que cubren el
# arranque, que es el camino que se rompió.
if ! git diff --quiet HEAD -- apps/web apps/api packages/ui ||
   ! git diff --cached --quiet -- apps/web apps/api packages/ui; then
  # Los workers vivos le roban los jobs al e2e: comparten base y Redis con él
  # (el preflight está aislado desde #1028, el e2e NO). Síntoma exacto:
  # `campanas.spec.ts` falla con «Esta campaña ya está cerrada» porque el worker
  # corrió el lote. Así que se avisa y se salta, en vez de dar un rojo que no es
  # del cambio: un chequeo que miente es peor que uno que no corre.
  if docker compose ps --status running --services 2>/dev/null | grep -qx workers; then
    printf '\033[1m── e2e bandeja\033[0m\n'
    printf '   \033[33mse salta: el contenedor `workers` está arriba.\033[0m\n'
    printf '   Comparte base y Redis con el e2e y le toma los jobs. Para correrlo:\n'
    printf '   docker compose stop workers && node apps/web/e2e/run-e2e.mjs bandeja\n'
  else
    paso 'e2e bandeja'  node apps/web/e2e/run-e2e.mjs bandeja
  fi
fi

# Los workflows, SOLO si los tocaste (#770).
#
# Un error de workflow —un `needs:` a un job que no existe, un `runs-on`
# mal escrito, una expresión que nombra algo no declarado— no se ve hasta
# empujar, y entonces cuesta una corrida de doce minutos. `actionlint` lo ve en
# 17 ms, sin Docker, con un binario de 5 MB.
#
# Si no está instalado, se dice y se sigue: un chequeo que bloquea por no estar
# instalado se desactiva el primer día con prisa, y este script existe para que
# nadie quiera desactivarlo.
#
# Por qué NO `act`: corre los workflows de verdad, pero para eso descarga su
# imagen de runner (de 1 a 18 GB) de Docker Hub —el cupo que #760 y #765 vinieron
# a sacar del camino— y no emula nada de lo que de verdad falla:
# `services.credentials`, la autenticación de GHCR, el caché `type=gha`, los
# `environments`, `concurrency` ni las cadenas de `workflow_run`.
if ! git diff --quiet HEAD -- .github/workflows || ! git diff --cached --quiet -- .github/workflows; then
  if command -v actionlint >/dev/null 2>&1; then
    paso 'workflows (actionlint)'        actionlint
  else
    printf '\033[1m── workflows (actionlint)\033[0m\n'
    printf '   \033[33mse salta: no está instalado.\033[0m Tocaste .github/workflows y esto lo revisa en 17 ms:\n'
    printf '   go install github.com/rhysd/actionlint/cmd/actionlint@latest\n'
    printf '   (o baja el binario de https://github.com/rhysd/actionlint/releases)\n'
  fi
  # Y shellcheck: `actionlint` lo usa para los bloques `run:` SI está en el
  # PATH, y si no, calla. Así que sin él esto da menos hallazgos que CI —me
  # pasó: medí «cero hallazgos» en local y CI encontró cuatro—. Un chequeo
  # local que mide menos que el de CI es peor que no tenerlo, porque da
  # confianza falsa.
  if command -v actionlint >/dev/null 2>&1 && ! command -v shellcheck >/dev/null 2>&1; then
    printf '   \033[33mOJO: sin shellcheck, actionlint NO revisa los bloques run:\033[0m\n'
    printf '   CI sí lo tiene, así que allá puede salir rojo lo que acá pasó. Instálalo:\n'
    printf '   apt-get install shellcheck\n'
  fi
fi

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
