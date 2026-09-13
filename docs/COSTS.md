# Costos de la etapa 1

Fijos, USD por mes, antes del primer cliente pagando. Precios de septiembre
2026 (SPEC §40); **se verifican al contratar cada servicio** y se actualiza la
fecha aquí.

| Componente | Plan | USD/mes | Verificado |
|---|---|---|---|
| VPS 4 vCPU / 8 GB NVMe (misma región que Supabase) | — | 60–75 | pendiente |
| Supabase | Pro (prod) + proyecto staging | 25 + 10 | pendiente |
| Cloudflare | Free + Access + R2 | 0–5 | pendiente |
| GHCR | Free (limpieza: últimas 10 imágenes) | 0 | — |
| Langfuse | Hobby → Core desde fase 3 | 0 → 29 | pendiente |
| Sentry · Grafana Cloud · Uptime Kuma | Free | 0 | — |
| **Total** | | **~100–120 · ~130–150 desde fase 3** | |

Variables (los únicos que crecen con clientes, con tope por tenant y
traspasados al plan): tokens de Gemini y conversaciones/mensajes de Meta vía
Kapso.

## Alertas de costo pendientes de incorporar

- **2026-10-01 — cambio de precios de Meta** (fuente: pricing FAQ de Kapso):
  los mensajes no-plantilla dejan de ser gratis y pasan a cobrarse por mensaje
  a tarifa utility. El supuesto "conversaciones de servicio gratis" de la
  sección 40 queda obsoleto → verificar tarifas Chile al implementar #43 y
  recalcular topes por plan (#67).
- Kapso cobra plataforma por volumen de mensajes/mes (Free 2k · Pro 100k,
  números extra USD 10 c/u · Platform 1M, USD 5 c/u). Incluirlo en el margen
  por tenant cuando se fijen precios.
- WABAs en moneda distinta de USD vía Kapso incluyen margen FX.

## Reglas de eficiencia (SPEC §40)

VPS y Supabase en la misma región · nunca Supabase Free · Gemini tier pago por
Developer API · contexto pequeño en sugerencias · modelo por tarea · cache de
conocimiento por tenant · Realtime por broadcast, nunca postgres_changes ·
adjuntos en R2, jamás en Postgres · medir desde el día uno (costo IA por
tenant/día, conversaciones Meta, tamaño de base, egress, CPU/memoria) y alertar
si algo crece más de 30 % semana a semana.
