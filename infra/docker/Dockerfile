# Imagen única de IAxTi: web, admin, api, workers y agents desde el mismo
# build; el entrypoint elige por SERVICE (ADR-0003). Se construye SOLO en
# GitHub Actions; el VPS hace pull.
FROM node:22-alpine AS build
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

FROM node:22-alpine AS runner
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
COPY --from=build /app/apps/agents/dist ./apps/agents/dist
COPY --from=build /app/apps/agents/package.json ./apps/agents/package.json
# web y admin en modo standalone (autocontenidos)
COPY --from=build /app/apps/web/.next/standalone ./standalone-web
COPY --from=build /app/apps/admin/.next/standalone ./standalone-admin
COPY infra/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
