# El Postgres que necesita el CI, sin pasar por Docker Hub (#760).
#
# ## Por qué se construye en vez de espejarse
#
# El CI necesita Postgres CON pgvector. La imagen de la comunidad
# (`pgvector/pgvector:pg16`) vive solo en Docker Hub, y Docker Hub limita las
# descargas anónimas por IP: las IP de los runners son compartidas, así que el
# cupo se agota y el job muere en «Initialize containers» con
# `toomanyrequests`, sin una línea de log de pruebas. El 09-10 dejó cinco PR
# trancados a la vez.
#
# El primer intento fue espejar esa imagen a GHCR. No sirve cuando hace falta:
# copiarla también es una descarga de Docker Hub, así que el espejo se cae por
# lo mismo que vino a arreglar (`ERROR: unexpected status from HEAD request to
# registry-1.docker.io: 429`). Un remedio que necesita que el problema no esté
# pasando no es un remedio.
#
# Esto, en cambio, no toca Docker Hub en ningún paso:
#
#  - `postgres` es una imagen OFICIAL, y AWS espeja las oficiales en
#    `public.ecr.aws/docker/library/*`, que permite descargas anónimas sin ese
#    cupo.
#  - pgvector es un paquete Debian del repositorio PGDG, que la imagen oficial
#    ya trae configurado. O sea: una línea de `apt-get`.
#
# ## Lo que no se pinea, y a sabiendas
#
# `postgresql-16-pgvector` va sin versión, así que sigue la última del
# repositorio. Medido al escribir esto: **0.8.7**, con `halfvec(2048)` y su
# índice HNSW funcionando, que es lo que usa el módulo `knowledge` (migración
# 0002). Pinear la versión exacta dejaría el CI probando contra una extensión
# vieja mientras producción avanza, y el riesgo que importa es el inverso: que
# una versión nueva cambie algo y el CI lo cace. Si algún día un salto rompe
# algo, ese es el momento de pinear, con el motivo escrito.
#
# Esto es para el CI. En local, `docker compose` sigue con lo que ya tiene
# descargado, y producción es Supabase.
FROM public.ecr.aws/docker/library/postgres:16

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-pgvector \
 && rm -rf /var/lib/apt/lists/*
