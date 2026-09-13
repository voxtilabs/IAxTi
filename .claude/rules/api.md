# Regla: API

- REST en `/v1`; cambio incompatible abre `/v2`, no rompe `/v1`.
- OpenAPI 3.1 generado desde los decoradores, publicado en `/docs`. Endpoint
  sin OpenAPI = endpoint que no existe. El SDK (`packages/sdk`) se regenera
  desde el contrato.
- Error único SIEMPRE: `{ code, message, requestId, details[] }`. `code` en
  SCREAMING_SNAKE; `message` con la voz de Pulso: qué pasó y qué hacer, sin
  "Error:", sin el mensaje crudo del sistema, español de Chile, tuteo.
- `X-Request-Id` entra o se genera; se propaga a logs, eventos, jobs y trazas.
- Paginación por cursor, límite máximo 100. Filtro `?filter[campo]=valor`,
  orden `?sort=-created_at`. Nunca offset.
- `Idempotency-Key` obligatorio en todo POST que crea o cobra.
- Rate limiting por tenant y por API key en Redis con cabeceras `RateLimit-*`;
  superado el límite: 429 con el formato único.
- Autenticación: JWT de Supabase Auth para usuarios; API key con scopes para
  integraciones (`actor_kind = apikey` en audit).
- El frontend consume la API por el SDK generado; nunca fetch a mano contra
  rutas inventadas, nunca tablas de Supabase directo.
