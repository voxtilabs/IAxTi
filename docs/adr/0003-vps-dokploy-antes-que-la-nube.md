# ADR 0003 · VPS con Dokploy antes que la nube

**Estado:** aceptada · 2026-09-13 · reemplaza el borrador "Cloud Run antes que GKE"

## Contexto
Antes del primer cliente pagando, la nube gestionada cuesta varias veces un VPS
y agrega IAM, Terraform y facturación por servicio que una persona no necesita
operar todavía.

## Decisión
Un VPS (4 vCPU / 8 GB, misma región que Supabase) con Dokploy: Traefik con TLS,
proyectos iaxti-staging e iaxti-prod, Redis como contenedor con AOF, deploy por
API desde GitHub Actions. Las imágenes se construyen en Actions y se publican en
GHCR; **el VPS solo hace pull**. Compose versionado en `infra/dokploy/`.
Cloudflare delante de todo; el VPS solo acepta 80/443 desde Cloudflare y SSH con
llave. Terraform se difiere: entra con la nube.

## Consecuencias
- Costo fijo ~100–120 USD/mes en etapa 1 (docs/COSTS.md).
- Servicios sin estado desde el día uno (adjuntos en R2, colas en Redis,
  sesiones en Supabase) para que el camino de escalado sea real.
- Helm chart existe y se valida contra kind en CI, pero no se despliega.

## Se revisa cuando (SPEC §38, por síntomas medidos)
- p95 de api > 500 ms sostenido o workers/agents compiten por CPU → segundo VPS.
- Réplicas o cero-downtime real → Dokploy en modo Swarm, 3 nodos.
- Cliente exige aislamiento, SLA o residencia; o el equipo crece → Cloud Run/GKE
  con la misma imagen.
