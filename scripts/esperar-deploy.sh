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

  # Por qué esto ya no es un `curl -fsS ... || echo` (#661).
  #
  # Con `-f` y un `||`, CUALQUIER fallo terminaba en la misma frase: «no se pudo
  # leer el detalle; queda el panel». Que la ruta no exista, que la credencial no
  # alcance, que Cloudflare Access la rechace o que el cuerpo no sea lo que `jq`
  # espera se veían idénticos. Cuatro causas, un mensaje — el mismo defecto que
  # #565 y #598 arreglaron en las otras llamadas de este archivo.
  #
  # Y este camino solo corre cuando el deploy YA falló, así que un error acá
  # deja a quien mira sin nada: pasó el 27/09, dos veces seguidas.
  #
  # El cuerpo crudo NO se publica: el log de Actions lo lee cualquiera con acceso
  # al repo y la respuesta de Dokploy puede arrastrar variables del entorno. Con
  # el código y la forma alcanza para saber a quién llamar.
  local cuerpo codigo
  cuerpo=$(curl -sS -m 20 -w '\n%{http_code}' "${auth[@]}" \
    "${DOKPLOY_URL}/api/deployment.all?composeId=${COMPOSE_ID}" 2>/dev/null) || true
  codigo=$(printf '%s' "$cuerpo" | tail -n1)
  cuerpo=$(printf '%s' "$cuerpo" | sed '$d')

  case "$codigo" in
    200) ;;
    000|'')
      echo "  No se pudo hablar con Dokploy para pedir el detalle (sin respuesta)."
      echo "  Suele ser la red o Cloudflare Access, no el despliegue."
      return ;;
    401|403)
      echo "  Dokploy contestó ${codigo} al pedir el detalle: la credencial llega pero"
      echo "  no alcanza para deployment.all. Es un permiso, no el despliegue."
      return ;;
    404)
      echo "  Dokploy contestó 404 al pedir el detalle: esa ruta no existe en esta"
      echo "  versión de Dokploy. Hay que mirar qué endpoint expone para los"
      echo "  despliegues; el arreglo es acá, no en el deploy."
      return ;;
    *)
      echo "  Dokploy contestó ${codigo} al pedir el detalle."
      return ;;
  esac

  if ! printf '%s' "$cuerpo" | jq -e . >/dev/null 2>&1; then
    echo "  Dokploy contestó 200 pero el cuerpo no es JSON (${#cuerpo} bytes)."
    echo "  Suele ser una pantalla de Cloudflare Access en vez de la API."
    return
  fi

  printf '%s' "$cuerpo" | jq -r 'if type == "array" then .[0:3] else . end
             | if type == "array" then .[] else . end
             | "  \(.createdAt // "?") · \(.status // "?") · \(.title // "sin título")\n  \(.errorMessage // .description // "sin detalle" | tostring | .[0:400])"' \
    || echo "  El cuerpo es JSON pero no tiene la forma esperada."
}

sondeos=$(( ESPERA_DEPLOY_SEG / PASO_SEG ))
echo "Esperando al deploy (hasta ${ESPERA_DEPLOY_SEG}s)..."
inicio=$(date +%s)
st=desconocido
for i in $(seq 1 "$sondeos"); do
  sleep "$PASO_SEG"
  # Un 502 transitorio NO puede matar la espera (#573).
  #
  # Esto era `curl -fsS … | jq` pelado bajo `set -euo pipefail`: un 502 de
  # Cloudflare Access —pasó el 26/09 y está documentado en el workflow— abortaba
  # el script, el paso salía 1, el Smoke nunca corría… y staging SÍ había
  # quedado desplegado. CI rojo sobre un despliegue sano, que es la combinación
  # que este repo declara la peor.
  #
  # `detalle_del_despliegue` ya se había blindado para esto (#661) y esta copia
  # —la que de verdad decide— quedó frágil. Es el patrón de #675 otra vez: se
  # arregla una de las dos y la que importaba sigue igual.
  #
  # Un sondeo que no se puede leer no es un fallo del despliegue: es un sondeo
  # perdido. Se dice y se sigue; el presupuesto total es el que corta.
  respuesta=$(curl -sS -m 20 -w '\n%{http_code}' "${auth[@]}" \
    "${DOKPLOY_URL}/api/compose.one?composeId=${COMPOSE_ID}" 2>&1) || respuesta=''
  http=$(printf '%s' "$respuesta" | tail -1)
  st=$(printf '%s\n' "$respuesta" | head -n -1 | jq -r '.composeStatus' 2>/dev/null) || st=''
  if [ -z "$st" ] || [ "$st" = 'null' ]; then
    echo "[$i] sondeo ilegible (HTTP ${http:-sin código}); sigo esperando"
    continue
  fi
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
