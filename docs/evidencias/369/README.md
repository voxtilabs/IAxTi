# Sentry y OpenTelemetry juntos · #369

Evidencia del defecto: en staging, con ambas integraciones configuradas, el
arranque del 20/09/2026 a las 03:07:27Z registró tres errores «Attempted duplicate
registration of API» para trace/context/propagation. Sentry 8 inicializaba sus
propios globales antes del NodeSDK destinado a Grafana. Poner su muestreo en
cero no impedía ese registro. No se afirma que causara los 500 de #361.

La corrección deja un solo registro a cargo del NodeSDK cuando OTLP está
activo. Sentry aporta su gestor de contexto y propagador para conservar el
ámbito de cada solicitud. No se agrega SentrySpanProcessor: los spans salen
por OTLP y Sentry recibe errores, según ADR-0006. Sin OTLP, Sentry conserva
su inicialización propia; sin ninguno de los dos, la telemetría sigue apagada.

El sampler conserva los seis modos estándar de OTel y añade el estado de
propagación de Sentry. Usar SentrySampler con muestreo cero en la versión 8
instalada descartaría también las trazas que deben llegar a Grafana.
`@sentry/opentelemetry` ya era dependencia transitiva en la versión 8.55.2;
se declara directamente porque ahora el código usa su API pública.

Referencia: [configuración OTel personalizada y Sentry solo para errores](https://docs.sentry.io/platforms/javascript/guides/node/opentelemetry/custom-setup/),
contrastada con los tipos y código de Sentry 8.55.2 instalados en el proyecto.

## Pruebas

22 pruebas de telemetría, incluidas ocho combinaciones ejecutadas en procesos
Node separados. Receptores HTTP locales reciben los envelopes reales del SDK
Sentry y los mensajes OTLP/JSON del SDK OTel. No se usan cuentas ni secretos
reales, ni se mandan eventos a servicios externos.

Se verifica: sin doble registro; excepción recibida; cero transacciones a
Sentry; spans exportados; padre e hijo con la misma traza; contexto W3C entre
jobs; error correlacionado con el trace_id; aislamiento de tags entre dos
solicitudes concurrentes; muestreo apagado y ratio cero respetados.

Regresión adicional: 73 pruebas de core con Postgres y Redis locales,
incluidos propagación en colas, registro de consumidores e idempotencia.

```sh
pnpm --filter @iaxti/telemetry build
pnpm --filter @iaxti/telemetry test
DATABASE_URL=... REDIS_URL=... pnpm --filter @iaxti/core test
```

La inspección del servidor fue de solo lectura. Esta corrección se entrega
por PR y CI; su despliegue debe seguir el flujo normal, sin parches manuales
sobre los contenedores.
