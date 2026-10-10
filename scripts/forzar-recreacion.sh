#!/usr/bin/env bash
# Si el contenedor no tomó la imagen nueva, obligarlo (#652).
#
# `compose.deploy` devuelve `done` a los 11 segundos y con `sourceType: raw` NO
# recrea los contenedores: guarda la configuración, recarga las variables de
# entorno, y deja corriendo la imagen anterior —mismo id, mismo
# `com.docker.compose.config-hash`—. Medido tres veces el 27/09: la espera del
# #643 aguantó 835 s y staging seguía sirviendo el build de antes.
#
# Eso es el fondo de #573, y lo caro no es el retraso: es que el despliegue
# **dice que salió bien**. Alguien pasa horas mirando una pantalla que corre
# código viejo mientras el log del deploy está en verde.
#
# Lo único que recrea con `raw` es pararlo y volver a levantarlo. Se hace SOLO
# cuando hace falta: `compose.stop` deja staging abajo unos minutos, y eso no se
# paga en cada despliegue. Se paga cuando la alternativa es servir código viejo
# sin saberlo, que ya es peor que estar abajo un rato —abajo se nota.
#
# `compose.start` no sirve para levantarlo: corre con `env -i` y sin el archivo
# de variables, así que ni `IMAGE` tiene valor. Por eso es stop + deploy.
#
# Entra por entorno: DOKPLOY_URL, DOKPLOY_API_KEY, COMPOSE_ID, las dos de
# Cloudflare Access, BASE (la URL pública) y SHA (el commit desplegado).
set -euo pipefail

: "${DOKPLOY_URL:?falta DOKPLOY_URL}"
: "${COMPOSE_ID:?falta COMPOSE_ID}"

# Sin BASE o sin SHA no hay nada contra qué comparar. Este mismo script corre de
# verdad en una prueba, donde no hay commit desplegado: comparar contra la nada y
# forzar un reinicio sería mucho peor que no hacer nada.
if [ -z "${BASE:-}" ] || [ -z "${SHA:-}" ]; then
  echo "Sin BASE o sin SHA: no se verifica qué imagen quedó viva."
  exit 0
fi

auth=(
  -H "x-api-key: ${DOKPLOY_API_KEY:-}"
  -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID:-}"
  -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET:-}"
)

PASO_SEG=${PASO_SEG:-10}
# Cuánto se le da al contenedor nuevo para atender después de forzarlo. Más
# generoso que la espera normal porque acá el arranque es EN FRÍO: el stack
# estuvo abajo y hay que bajar la imagen entera.
ESPERA_RECREAR_SEG=${ESPERA_RECREAR_SEG:-600}

# Qué SHA está atendiendo, o vacío si no se pudo saber.
#
# NUNCA falla (#667). Con `set -euo pipefail`, la versión anterior
# —`curl … | jq -r '.sha // empty'`— tumbaba el paso entero ante cualquier
# respuesta que `jq` no supiera leer: una página de error del proxy, un cuerpo
# vacío, una `BASE` con barra final. Eso convirtió un despliegue EXITOSO en uno
# rojo, en el script cuyo trabajo es justamente que el despliegue diga la verdad.
#
# Y va contra lo que ya estaba decidido acá: «no pude leer qué build está vivo»
# es un estado que este script maneja —lo imprime como `<no informa el SHA>` y
# sigue—. Tumbar el paso era lo contrario.
# La lectura vive en su propio script porque el workflow de despliegue la
# necesita igual, y tenerla dos veces fue el defecto de #675: #668 arregló esta
# copia y la del workflow siguió cayéndose. Una regla, una implementación.
que_atiende() {
  "$(dirname "$0")/sha-de-health.sh"
}

# El SHA de `/health` es CORTO; el del commit, largo. Se compara por prefijo.
es_el_desplegado() {
  [ -n "$1" ] && [ "${SHA#"$1"}" != "${SHA}" ]
}

# Se ESPERA antes de concluir que no recreó (#573, y es la causa de #254).
#
# Esto sondeaba `/health` UNA vez, inmediatamente después de que Dokploy dijo
# `done`, y si el SHA no calzaba detenía el stack. Pero el propio workflow tiene
# medido —y escrito— que entre ese `done` y el primer `/health` del build nuevo
# pasan unos DIEZ minutos, y que en ese rato **contesta el contenedor viejo con
# su SHA** (#643, `deploy-staging.yml`).
#
# O sea que el sondeo único veía el SHA viejo casi siempre, aunque Dokploy
# hubiera recreado perfectamente: detenía staging y pagaba un arranque en frío
# en CADA despliegue. Eso es exactamente el síntoma de #254 —«cada despliegue
# deja staging sin atender unos diez minutos»— y la causa estaba acá.
#
# El presupuesto es el mismo que el Smoke le da al mismo tránsito, porque es el
# mismo tránsito: dos pasos consecutivos midiendo lo mismo con presupuestos
# incompatibles era el defecto, y el que no esperaba era el que apagaba el
# servicio. En el camino feliz esto no agrega tiempo: la espera se adelanta
# acá y el Smoke la encuentra ya cumplida.
ESPERA_SHA_SEG=${ESPERA_SHA_SEG:-660}
PASO_SHA_SEG=${PASO_SHA_SEG:-15}
echo "Esperando a que conteste el build desplegado (hasta ${ESPERA_SHA_SEG}s)..."
inicio_sha=$(date +%s)
vivo=''
# Sondea SIEMPRE una vez y después mientras quede presupuesto: con
# `ESPERA_SHA_SEG=0` esto se comporta como antes —una sola mirada— que es lo que
# las pruebas del camino de forzado necesitan para no esperar once minutos.
while :; do
  vivo=$(que_atiende)
  if es_el_desplegado "$vivo"; then
    echo "El contenedor tomó la imagen (${vivo}) a los $(( $(date +%s) - inicio_sha ))s; no hay nada que forzar."
    exit 0
  fi
  [ $(( $(date +%s) - inicio_sha )) -ge "$ESPERA_SHA_SEG" ] && break
  sleep "$PASO_SHA_SEG"
done
echo "Pasaron $(( $(date +%s) - inicio_sha ))s y sigue contestando ${vivo:-<nada>}."

echo "=============================================================="
echo "EL CONTENEDOR NO TOMÓ LA IMAGEN."
echo "  atiende:    ${vivo:-<no informa el SHA>}"
echo "  se desplegó: ${SHA}"
echo ""
echo "Dokploy dijo que el despliegue terminó bien. Con sourceType raw eso"
echo "significa que guardó la configuración, NO que recreó los contenedores."
echo "Se fuerza parando el stack y volviéndolo a levantar, que es lo único"
echo "que lo recrea. Staging queda abajo mientras tanto — a propósito: es"
echo "preferible a seguir sirviendo código viejo diciendo que salió bien."
echo "=============================================================="

curl -fsS -X POST "${auth[@]}" -H "Content-Type: application/json" \
  -d "{\"composeId\": \"${COMPOSE_ID}\"}" "${DOKPLOY_URL}/api/compose.stop" >/dev/null
echo "Stack detenido."

curl -fsS -X POST "${auth[@]}" -H "Content-Type: application/json" \
  -d "{\"composeId\": \"${COMPOSE_ID}\"}" "${DOKPLOY_URL}/api/compose.deploy" >/dev/null
echo "Despliegue pedido de nuevo. Esperando a que atienda el build nuevo..."

inicio=$(date +%s)
sondeos=$(( ESPERA_RECREAR_SEG / PASO_SEG ))
for _ in $(seq 1 "$sondeos"); do
  sleep "$PASO_SEG"
  vivo=$(que_atiende)
  if es_el_desplegado "$vivo"; then
    echo "Listo: ahora atiende ${vivo}, en $(( $(date +%s) - inicio ))s desde que se forzó."
    exit 0
  fi
done

echo "Después de forzarlo, sigue sin tomar la imagen tras ${ESPERA_RECREAR_SEG}s."
echo "  atiende:     ${vivo:-<no informa el SHA>}"
echo "  se desplegó: ${SHA}"
echo "Esto ya no es lentitud: revisa el panel de Dokploy y si la imagen existe"
echo "en el registro. El despliegue se da por FALLADO, que es la verdad."
exit 1
