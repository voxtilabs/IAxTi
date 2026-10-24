#!/bin/sh
# Volumen local NUEVO: el rol de la aplicación nace junto con la base (#370).
# Corre dentro de docker-entrypoint-initdb.d, donde psql ya está autenticado
# como el dueño. La clave local es igual al nombre (la convención que fijó
# rls.test.ts, como iaxti:iaxti del dueño) — local solamente; en staging/prod
# la pone el gestor de secretos, nunca un archivo.
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v rol=iaxti_app -v clave=iaxti_app \
  -f /iaxti/rol-de-la-aplicacion.sql
