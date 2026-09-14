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
Zavu.

## Alertas de costo pendientes de incorporar

- **2026-10-01 — cambio de precios de Meta**:
  los mensajes no-plantilla dejan de ser gratis y pasan a cobrarse por mensaje
  a tarifa utility. El supuesto "conversaciones de servicio gratis" de la
  sección 40 queda obsoleto → verificar tarifas Chile al implementar #43 y
  recalcular topes por plan (#67).
- **Zavu cobra por conexión provisionada** (una conexión = un canal conectado;
  el plan gratis trae dos, una puede ser WhatsApp). El precio mensual por
  conexión en plan pago **está pedido y no ha llegado**: es el número que decide
  el margen por tenant, porque escala con cada cliente.
- WhatsApp lo factura Meta directo, sin margen del intermediario. Las tarifas de
  Meta para Chile siguen pendientes de confirmar.
- SMS a Chile por Zavu, desde crédito prepago: **USD 0.067** ida y vuelta (desde
  número propio, el cliente puede responder) y **USD 0.034** solo salida (ruta
  compartida, sin respuestas — sirve para OTP y avisos, jamás para atención).
  Email: USD 0.40/1k transaccional, USD 0.80/1k marketing.
- Zavu **no separa la facturación por cliente final**: todo cae a nuestra cuenta
  y se prorratea por tenant en `usage_meters`.

## Reglas de eficiencia (SPEC §40)

VPS y Supabase en la misma región · nunca Supabase Free · Gemini tier pago por
Developer API · contexto pequeño en sugerencias · modelo por tarea · cache de
conocimiento por tenant · Realtime por broadcast, nunca postgres_changes ·
adjuntos en R2, jamás en Postgres · medir desde el día uno (costo IA por
tenant/día, conversaciones Meta, tamaño de base, egress, CPU/memoria) y alertar
si algo crece más de 30 % semana a semana.
