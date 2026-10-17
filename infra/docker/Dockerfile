# Imagen única de IAxTi: web, admin, api, workers y agents desde el mismo
# build; el entrypoint elige por SERVICE (ADR-0003). Se construye SOLO en
# GitHub Actions; el VPS hace pull.
#
# ## La base sale de NUESTRO espejo (#765)
#
# Y el camino hasta acá vale contarlo, porque la lección cambió dos veces.
#
# **Primero** salía de Docker Hub, que limita las descargas anónimas por IP y
# las IP de los runners son compartidas: cuando el cupo se agota, el build
# muere antes de empezar (#760).
#
# **Después** pasó a `public.ecr.aws/docker/library/*`, con este argumento:
# «`node` es una imagen OFICIAL y AWS espeja las oficiales ahí; es la MISMA
# imagen en un registro que no limita las descargas anónimas». La primera
# mitad es cierta. La segunda es falsa: ECR público no tiene el cupo de Docker
# Hub, **tiene el suyo**, y el 12-10 lo agotó bajando redis en el CI, con tres
# `toomanyrequests: Data limit exceeded` seguidos (#877).
#
# **Ahora** sale de GHCR, autenticado, donde no hay cupo para nosotros. Lo que
# de verdad se aprendió no es «no uses tal registro»: es **no dependas de un
# cupo que fija alguien que no sos vos**.
#
# Acá importa más que en el CI: `build.yml` publica la imagen que corre en
# staging y producción, y `release.yml` promueve la del commit EXACTO que se
# taguea — un build que nunca produjo imagen hace fallar la release el día que
# importa. Y medido, la exposición es comparable: 18 builds contra 33 corridas
# de CI el día pico de la última semana.
#
# El espejo lo refresca `imagen-node.yml`, semanal, y comprueba que la copia
# CORRA —`node --version` y que sea v22— antes de publicarla.
#
# ## El costo, que es real
#
# El paquete de GHCR es privado, así que `docker compose build` en una máquina
# local necesita, una vez:
#
#     docker login ghcr.io -u <usuario>    # token con read:packages
#
# Se asume a cambio de que el deploy no dependa de un cupo ajeno. Si el
# paquete se hace público, la molestia desaparece sin tocar nada de esto.
#
# ## Lo que todavía NO sale de nuestro espejo
#
# Los nodos de `kind` y el contenedor de ZAP, en sus propios workflows. Son de
# terceros y no se arreglan con un `FROM`. El BuildKit de
# `setup-buildx-action` ya no entra: `build.yml` construye con `docker build`
# pelado, y la guarda de `los-servicios-del-ci` impide que vuelva.
FROM ghcr.io/voxtilabs/node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@12.4.1
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build
# Next standalone necesita los estáticos junto al server
RUN for a in web admin; do \
      cp -r /app/apps/$a/.next/static /app/apps/$a/.next/standalone/apps/$a/.next/static; \
      if [ -d /app/apps/$a/public ]; then cp -r /app/apps/$a/public /app/apps/$a/.next/standalone/apps/$a/public; fi; \
    done

FROM ghcr.io/voxtilabs/node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
# api, workers y agents compilados con sus dependencias del workspace
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/workers/dist ./apps/workers/dist
COPY --from=build /app/apps/workers/package.json ./apps/workers/package.json
COPY --from=build /app/apps/workers/node_modules ./apps/workers/node_modules
COPY --from=build /app/apps/agents/dist ./apps/agents/dist
COPY --from=build /app/apps/agents/package.json ./apps/agents/package.json
COPY --from=build /app/apps/agents/node_modules ./apps/agents/node_modules
# TODOS los packages del workspace: los symlinks de node_modules apuntan a
# ../../packages/* y cualquiera ausente rompe el arranque (lo cazó workers
# con @iaxti/telemetry). Incluye los manifiestos que lee el registry.
COPY --from=build /app/packages ./packages
# web y admin en modo standalone (autocontenidos)
COPY --from=build /app/apps/web/.next/standalone ./standalone-web
COPY --from=build /app/apps/admin/.next/standalone ./standalone-admin
COPY infra/docker/entrypoint.sh /entrypoint.sh
# Los cinco servicios escuchan en un puerto no privilegiado. El código queda
# de root y solo las cachés de Next son escribibles por el usuario de runtime.
# UID/GID 1000 es node en la imagen oficial que copia nuestro espejo (#758).
RUN chmod +x /entrypoint.sh && \
    for a in web admin; do \
      mkdir -p /app/standalone-$a/apps/$a/.next/cache; \
      chown -R 1000:1000 /app/standalone-$a/apps/$a/.next/cache; \
    done
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
