#!/usr/bin/env bash
# Siembra las llaves de proveedor en el env de Dokploy (#848, #850, #860).
#
# Lee el documento de env por la entrada, escribe el nuevo por la salida, y los
# mensajes para la persona por el error. Está en un script y no dentro del
# workflow por una razón sola: acá se puede probar. El bloque equivalente en
# YAML solo se podía mirar, y lo que se mira se cree.
#
# Las llaves viajan como secretos de GitHub y se siembran si faltan, así ningún
# humano las pega en el panel. Si el panel ya tiene valor, manda el panel: el
# operador puede haberla rotado ahí a las tres de la mañana sin abrir un PR.
#
# Tres casos, y los tres importan:
#
#   ausente   → se agrega.
#   vacía     → se agrega (#850). Una línea vacía no es «el operador la rotó»:
#               es nada. El compose la referencia, así que la línea aparece sola.
#   con valor → manda el panel, y se COMPARA (#860). Que el panel gane no es
#               razón para no mirar: una llave equivocada se ve idéntica a una
#               rotada a mano, y el producto responde «tiene credencial» para
#               las dos. El valor nunca sale; sale su huella.
set -euo pipefail

# 12 hex de sha256: alcanza para comparar dos llaves, no para reconstruir una.
huella() { printf '%s' "$1" | sha256sum | cut -c1-12; }

env_nuevo=$(cat)

for var in "$@"; do
  valor="${!var:-}"
  [ -z "$valor" ] && continue
  en_panel=$(printf '%s\n' "$env_nuevo" | grep "^${var}=." | head -1 | cut -d= -f2- || true)
  if [ -n "$en_panel" ]; then
    if [ "$en_panel" = "$valor" ]; then
      echo "en el panel y es la misma que el secreto: ${var} ($(huella "$valor"))" >&2
    else
      echo "::warning title=Llave distinta a la del secreto::${var} en el panel de Dokploy NO es la del secreto de GitHub. Manda el panel. panel=$(huella "$en_panel") largo=${#en_panel} · secreto=$(huella "$valor") largo=${#valor}" >&2
    fi
    continue
  fi
  # Ausente, o presente y vacía: se quita la vacía y se agrega, para no dejar
  # la variable dos veces.
  env_nuevo=$(printf '%s\n' "$env_nuevo" | grep -v "^${var}=$" || true)
  env_nuevo=$(printf '%s\n%s=%s' "$env_nuevo" "$var" "$valor")
  echo "sembrada en el env de Dokploy: ${var}" >&2
done

printf '%s\n' "$env_nuevo"
