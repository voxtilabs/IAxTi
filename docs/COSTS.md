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
Zernio.

## Alertas de costo pendientes de incorporar

- **2026-10-01 — cambio de precios de Meta**:
  los mensajes no-plantilla dejan de ser gratis y pasan a cobrarse por mensaje
  a tarifa utility. El supuesto "conversaciones de servicio gratis" de la
  sección 40 queda obsoleto → verificar tarifas Chile al implementar #43 y
  recalcular topes por plan (#67).
- **Zernio cobra por cuenta conectada** (ADR-0032): el plan incluye 2 cuentas
  y luego cobra 6/3/1 USD por cuenta según banda — cifras de la evaluación del
  11-11: ≈ 77 USD/mes a 10 cuentas · 300k mensajes, ≈ 168 a 50. La
  suscripción es del despliegue, así que esa tarifa escala con cada cliente y
  es el número que decide el margen por tenant.
- WhatsApp lo factura Meta **directo al cliente**: Zernio como Tech Provider
  no tiene línea de crédito (ADR-0032). Las tarifas de Meta para Chile siguen
  pendientes de confirmar.
- SMS por Zernio: no aparece en su spec ni en la evaluación (ADR-0032) —
  **no medido**;
  si un caso lo necesita, pedirlo y verificarlo antes de prometerlo. Los
  precios de SMS y email anotados antes (0,067/0,034 USD y 0,40/1k
  transaccional) eran del crédito de Zavu y se fueron con él. El correo va
  por Resend (#55): precio por verificar al contratar.
- Zernio **sí separa por negocio**: cada tenant tiene su perfil y su llave
  restringida a él (ADR-0033); lo que queda de nuestra cuenta es la tarifa
  por cuenta del primer punto, no un prorrateo por mensaje.

## Reglas de eficiencia (SPEC §40)

VPS y Supabase en la misma región · nunca Supabase Free · Gemini tier pago por
Developer API · contexto pequeño en sugerencias · modelo por tarea · cache de
conocimiento por tenant · Realtime por broadcast, nunca postgres_changes ·
adjuntos en R2, jamás en Postgres · medir desde el día uno (costo IA por
tenant/día, conversaciones Meta, tamaño de base, egress, CPU/memoria) y alertar
si algo crece más de 30 % semana a semana.
