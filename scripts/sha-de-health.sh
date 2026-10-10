#!/usr/bin/env bash
# Leer el SHA que informa /health, sin poder tumbar a quien lo llama (#675).
#
# Existe porque esta lectura estaba escrita DOS veces: una en
# forzar-recreacion.sh y otra —dos veces— dentro del workflow de despliegue.
# #668 arregló la del script; la del workflow siguió igual, y el despliegue de
# ed072a2 quedó rojo después de aplicarse bien:
#
#   [42] done
#   Deploy aplicado en 448s.
#   jq: error (at <stdin>:1): Cannot index number with string "sha"
#   ##[error]Process completed with exit code 5.
#
# `jq` sale con código 5 cuando el cuerpo no es un objeto JSON, y con `set -e`
# ese 5 mata el paso. El rojo no hablaba del despliegue: hablaba del parseo.
#
# Acá la lectura NUNCA falla —sale 0 siempre, con el SHA o con nada— porque leer
# no es decidir. Quien llama decide qué significa un SHA vacío: el script fuerza
# la recreación, el smoke falla por la vía de #573 con su mensaje. Esa
# separación es lo que hace que un /health ilegible se lea como lo que es.
#
# Y cuando no se puede leer, lo dice por STDERR con el código HTTP y un pedazo
# del cuerpo. Un `jq: parse error` no es un diagnóstico; un «404 page not found»
# de Traefik dice en qué punto se rompió la cadena.
#
# Entra por BASE (o primer argumento). Sale por STDOUT: el SHA corto, o nada.
set -uo pipefail

base="${1:-${BASE:-}}"
[ -n "$base" ] || exit 0

# `${base%/}` quita la barra final: con ella la ruta queda `//health`, que
# algunos proxies contestan con un 404 propio.
respuesta=$(curl -sS -m 15 -w '\n%{http_code}' "${base%/}/health" 2>&1) || {
  echo "sha-de-health: /health no contestó (curl falló): $(printf '%s' "$respuesta" | head -c 200)" >&2
  exit 0
}
codigo=$(printf '%s' "$respuesta" | tail -1)
cuerpo=$(printf '%s\n' "$respuesta" | head -n -1)

if [ -z "$cuerpo" ]; then
  echo "sha-de-health: /health contestó ${codigo} con el cuerpo vacío." >&2
  exit 0
fi

# La clave AUSENTE y `"sha": null` son dos cosas distintas (#573).
#
# `jq -r '.sha // empty'` las colapsaba en vacío, y son diagnósticos opuestos:
#
#  - **ausente**: está corriendo una imagen anterior a #566, que todavía no
#    informaba el SHA. Ahí sí hay que mirar la imagen.
#  - **`null`**: la imagen es nueva —`version.ts` siempre serializa la clave— y
#    lo que no llegó es la VARIABLE `IAXTI_IMAGE`. Ahí mirar la imagen es
#    perder el tiempo: el problema está en el `environment` del compose.
#
# El 26/09 `/health` contestó `{"status":"ok","service":"api","sha":null}` y el
# diagnóstico que salió fue «está corriendo una imagen anterior a #566», que es
# mentira y manda al operador al lugar equivocado.
tiene_clave=$(printf '%s' "$cuerpo" | jq -r 'has("sha")' 2>/dev/null) || tiene_clave='false'
sha=$(printf '%s' "$cuerpo" | jq -r '.sha // empty' 2>/dev/null) || sha=''
if [ -z "$sha" ]; then
  if [ "$tiene_clave" = 'true' ]; then
    echo "sha-de-health: /health contestó ${codigo} con \"sha\": null — la imagen es nueva y lo que NO llegó es IAXTI_IMAGE. Revisa el environment del compose, no la imagen. Cuerpo:" >&2
  else
    echo "sha-de-health: /health contestó ${codigo} SIN la clave .sha — está corriendo una imagen anterior a #566. Cuerpo:" >&2
  fi
  printf '%s\n' "$cuerpo" | head -c 600 >&2
  echo >&2
  exit 0
fi

printf '%s' "$sha"
