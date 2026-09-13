import * as Sentry from '@sentry/node';

/**
 * Observabilidad base (SPEC §14, ADR-0006): Sentry para errores y
 * OpenTelemetry → Grafana Cloud para trazas de plataforma. Todo activado por
 * entorno — sin SENTRY_DSN u OTEL_EXPORTER_OTLP_ENDPOINT, cada pieza queda
 * apagada sin romper nada. Se llama UNA vez, al inicio del entrypoint,
 * ANTES de cargar el framework.
 *
 * Langfuse (trazas de IA) llega con la Fase 3 y NO pasa por aquí: plataforma
 * en OTel, IA en Langfuse, mismo trace_id (SPEC §14).
 */
export function initObservability(serviceName: string): void {
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.IAXTI_ENV ?? 'local',
      serverName: serviceName,
      // Trazas van por OTel; Sentry queda solo para errores (ADR-0006).
      tracesSampleRate: 0,
    });
  }

  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    // Import diferido: el SDK de OTel es pesado y solo se paga si está activo.
    // El exportador OTLP y sus cabeceras salen de las variables estándar
    // OTEL_EXPORTER_OTLP_* que el SDK lee solo.
    process.env.OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? `iaxti-${serviceName}`;
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { NodeSDK } = require('@opentelemetry/sdk-node') as typeof import('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } =
      require('@opentelemetry/auto-instrumentations-node') as typeof import('@opentelemetry/auto-instrumentations-node');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const sdk = new NodeSDK({
      instrumentations: [
        getNodeAutoInstrumentations({
          // El fs genera ruido enorme y ningún diagnóstico útil aquí.
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });
    sdk.start();

    const shutdown = () => {
      void sdk.shutdown().finally(() => process.exit(0));
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
}

/** Reporta un error no controlado a Sentry (no-op sin DSN). */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!process.env.SENTRY_DSN) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

/** Vacía la cola de Sentry (útil antes de salir en procesos cortos). */
export async function flushTelemetry(timeoutMs = 2000): Promise<void> {
  if (process.env.SENTRY_DSN) await Sentry.flush(timeoutMs);
}
