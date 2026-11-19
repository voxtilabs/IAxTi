#!/usr/bin/env bash
# Siembra la URL del rol de aplicación en el env de Dokploy (#370).
#
# Se llama con DOS nombres: la variable del Action que trae el secreto y la
# línea del env que hay que reemplazar:
#
#   scripts/sembrar-url-app.sh DATABASE_URL_APP DATABASE_URL
#
# Y hace lo OPUESTO a `sembrar-llaves.sh`, a propósito. Allá manda el panel,
# porque rotar una llave a las tres de la mañana sin abrir un PR es legítimo.
# Acá manda el SECRETO, porque cambiar CON QUÉ ROL CONECTA LA APLICACIÓN no es
# una rotación: es la diferencia entre que el aislamiento entre tenants exista
# o no exista, y una decisión así se revisa en un PR. Si el panel quedó con la
# URL del dueño (superusuario con BYPASSRLS) y el secreto dice otra cosa, se
# ve — con las huellas, nunca los valores, que son contraseñas — y manda el
# secreto.
#
# Con el secreto VACÍO no toca nada: nadie decidió aún, el panel manda, y el
# arranque sigue gritando SIN AISLAMIENTO cada media hora hasta que alguien
# tome la decisión. Un vacío no es «decidimos dejar al dueño»: para eso está
# poner la URL del dueño en el secreto, que es una decisión explícita y
# reversible igual que cualquier otra.
#
# La reversión es el mismo camino al revés: se cambia el secreto y se vuelve
# a desplegar. Nada de tocar el panel a mano: lo que el panel tenga queda
# pisado por el próximo deploy que tenga el secreto puesto.
set -euo pipefail

# 12 hex de sha256: alcanza para comparar dos URLs, no para reconstruir una.
huella() { printf '%s' "$1" | sha256sum | cut -c1-12; }

if [ "$#" -ne 2 ]; then
  echo "uso: $0 <VAR_DEL_SECRETO> <VAR_DEL_ENV> (ej: DATABASE_URL_APP DATABASE_URL)" >&2
  exit 2
fi
secreto="$1"
destino="$2"

env_doc=$(cat)
valor="${!secreto:-}"
if [ -z "$valor" ]; then
  printf '%s\n' "$env_doc"
  exit 0
fi

# Ni sed ni regex sobre una línea que trae :// : @ ? y = adentro: se recorre
# línea por línea y se compara el prefijo exacto.
nueva=()
reemplazada=0
while IFS= read -r linea || [ -n "$linea" ]; do
  case "$linea" in
    "$destino="*)
      previa="${linea#"$destino"=}"
      if [ "$previa" = "$valor" ]; then
        echo "en el panel y es la misma que el secreto: $destino ($(huella "$valor"))" >&2
      else
        echo "::warning title=URL del rol distinta a la del panel::$destino en el panel de Dokploy NO es la del secreto. Manda el SECRETO (#370): la cadena de conexión se cambia por PR, no desde el panel. panel=$(huella "$previa") · secreto=$(huella "$valor")" >&2
      fi
      nueva+=("$destino=$valor")
      reemplazada=1
      ;;
    *)
      nueva+=("$linea")
      ;;
  esac
done <<< "$env_doc"

if [ "$reemplazada" -eq 0 ]; then
  nueva+=("$destino=$valor")
  echo "sembrada en el env de Dokploy: $destino (no tenía línea)" >&2
fi

printf '%s\n' "${nueva[@]}"
