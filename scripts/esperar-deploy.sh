#!/usr/bin/env bash
# Espera a que Dokploy termine el despliegue, y cuenta qué pasó si no termina.
#
# Vive en un script y no dentro del workflow (#571) por una razón concreta: la
# primera versión de «un deploy fallido dice por qué» cubría la rama de `error` y
# no la del timeout, y el despliegue que la estrenó falló justo por timeout — así
# que el arreglo no se activó. Un bucle de espera dentro de un `run:` de 40 líneas
# no se puede probar, y lo que no se prueba tiene una rama sin cubrir.
#
# Entra por entorno: DOKPLOY_URL, DOKPLOY_API_KEY, COMPOSE_ID, y las dos de
# Cloudflare Access. ESPERA_DEPLOY_SEG es el presupuesto.
set -euo pipefail

: "${DOKPLOY_URL:?falta DOKPLOY_URL}"
: "${COMPOSE_ID:?falta COMPOSE_ID}"

auth=(
  -H "x-api-key: ${DOKPLOY_API_KEY:-}"
  -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID:-}"
  -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET:-}"
)

# Cuánto se espera, escrito y con motivo. Un `seq 1 90` sin explicación eran
# quince minutos que nadie eligió. Y subir el número cada vez que salta convierte
# el límite en un adorno: la espera se MIDE y se compara contra esto (#254).
ESPERA_DEPLOY_SEG=${ESPERA_DEPLOY_SEG:-900}
PASO_SEG=${PASO_SEG:-10}

# Qué informa Dokploy del último despliegue. Lo usan las DOS salidas.
#
# Solo los campos ESTRUCTURADOS, no el log crudo: la salida de un `compose up`
# puede arrastrar nombres y valores del entorno, y el log de Actions lo lee
# cualquiera con acceso al repo. Con el estado y el mensaje alcanza para
# distinguir «la imagen no estaba» de «el contenedor no arrancó».
detalle_del_despliegue() {
  echo "Lo que informa Dokploy del último despliegue:"
  curl -fsS "${auth[@]}" "${DOKPLOY_URL}/api/deployment.all?composeId=${COMPOSE_ID}" 2>/dev/null \
    | jq -r 'if type == "array" then .[0:3] else . end
             | if type == "array" then .[] else . end
             | "  \(.createdAt // "?") · \(.status // "?") · \(.title // "sin título")\n  \(.errorMessage // .description // "sin detalle" | tostring | .[0:400])"' \
    || echo "  (no se pudo leer el detalle; queda el panel de Dokploy)"
}

sondeos=$(( ESPERA_DEPLOY_SEG / PASO_SEG ))
echo "Esperando al deploy (hasta ${ESPERA_DEPLOY_SEG}s)..."
inicio=$(date +%s)
st=desconocido
for i in $(seq 1 "$sondeos"); do
  sleep "$PASO_SEG"
  st=$(curl -fsS "${auth[@]}" "${DOKPLOY_URL}/api/compose.one?composeId=${COMPOSE_ID}" | jq -r '.composeStatus')
  echo "[$i] $st"
  if [ "$st" = "done" ]; then
    echo "Deploy aplicado en $(( $(date +%s) - inicio ))s."
    exit 0
  fi
  if [ "$st" = "error" ]; then
    # Antes esto era la última línea del log: «Deploy falló en Dokploy» y nada
    # más (#565). Un fallo transitorio y uno real se veían idénticos, así que
    # había que entrar al panel para saber cuál era — y eso enseña a reintentar
    # sin mirar.
    echo "Dokploy reporta ERROR en el despliegue."
    detalle_del_despliegue
    exit 1
  fi
done

# Seguir en «running» NO es lo mismo que fallar, y llamarlos igual es lo que hace
# que nadie mire (#571).
espera=$(( $(date +%s) - inicio ))
echo "Dokploy sigue en \"${st}\" después de ${espera}s (presupuesto ${ESPERA_DEPLOY_SEG}s)."
echo "No es un fallo reportado: es una espera que se pasó del límite. Si se repite,"
echo "el número que hay que mirar es el de #254, no este timeout."
detalle_del_despliegue
exit 1
