# ADR 0006 · Langfuse para IA, OpenTelemetry para plataforma

**Estado:** aceptada · 2026-09-13

## Contexto
La observabilidad de LLMs (prompts, generaciones, tokens, costo, evaluaciones)
y la de plataforma (trazas, métricas, logs) son problemas distintos; una sola
herramienta hace mal alguno de los dos.

## Decisión
Langfuse Cloud para IA: trazas de agentes, prompts versionados, costos,
evaluaciones y anotación. OpenTelemetry → Grafana Cloud para plataforma. Sentry
para errores en los cinco servicios. Mismo `trace_id` en las tres capas; trazas
de IA etiquetadas con tenant, user, conversation, agent, session y request.
OTel no duplica lo que Langfuse registra. Redacción de PII antes de Langfuse
según la política del tenant.

## Consecuencias
- El centro de IA del SuperAdmin lee de Langfuse por API y cachea; solo los
  agregados por tenant se guardan en nuestra base (billing).
- Langfuse Hobby hasta la fase 3; Core cuando entren evaluaciones (~29 USD/mes).
- Alertas mínimas desde el día uno: error rate, p95, webhooks fallidos, cola
  atascada, costo de IA por tenant fuera de rango.

## Se revisa cuando
Un contrato exija datos de IA en infraestructura propia → Langfuse self-hosted.
