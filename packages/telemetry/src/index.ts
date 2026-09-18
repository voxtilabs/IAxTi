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

/**
 * La traza cruzando la cola (#17, SPEC §14).
 *
 * La instrumentación automática ata el request HTTP con la consulta a
 * Postgres porque todo ocurre en la misma pila. Un job de BullMQ no: se
 * encola ahora y se ejecuta después, en otro proceso. Sin esto, el trabajo
 * del worker arranca una traza NUEVA y la pregunta "¿qué pasó con el
 * mensaje que mandó este cliente?" se contesta mirando dos trazas sueltas
 * y adivinando cuál va con cuál.
 *
 * El formato es W3C `traceparent`, el estándar: el mismo que viaja en las
 * cabeceras HTTP. Sin SDK activo, `inject` no escribe nada y esto queda en
 * un objeto vacío — apagado, no roto.
 */
export function contextoDeTraza(): Record<string, string> {
  const carrier: Record<string, string> = {};
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const api = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
    /* eslint-enable @typescript-eslint/no-require-imports */
    api.propagation.inject(api.context.active(), carrier);
  } catch {
    /* sin OTel instalado no hay traza que propagar */
  }
  return carrier;
}

/**
 * Corre `fn` dentro de la traza que venía en el job, bajo un span propio.
 * `atributos` lleva el tenant y el módulo: sin tenant, una latencia alta es
 * un número sin dueño y no se puede saber a quién le está yendo mal.
 */
export async function conTrazaDelJob<T>(
  carrier: Record<string, string> | undefined,
  nombre: string,
  atributos: Record<string, string | number | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  let api: typeof import('@opentelemetry/api');
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    api = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
    /* eslint-enable @typescript-eslint/no-require-imports */
  } catch {
    return fn();
  }

  const padre = carrier ? api.propagation.extract(api.context.active(), carrier) : api.context.active();
  const limpios = Object.fromEntries(
    Object.entries(atributos).filter(([, v]) => v !== undefined),
  ) as Record<string, string | number>;

  return api.trace
    .getTracer('iaxti-queues')
    .startActiveSpan(nombre, { attributes: limpios }, padre, async (span) => {
      try {
        const r = await fn();
        span.setStatus({ code: api.SpanStatusCode.OK });
        return r;
      } catch (err) {
        // El error se marca en el span y se relanza: BullMQ tiene que verlo
        // para reintentar. Tragárselo acá convertiría un job fallido en uno
        // exitoso y vacío.
        span.recordException(err as Error);
        span.setStatus({ code: api.SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    });
}

/** El trace_id vigente, para meterlo en un log o en una fila. */
export function trazaActual(): string | null {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const api = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const ctx = api.trace.getSpanContext(api.context.active());
    return ctx?.traceId ?? null;
  } catch {
    return null;
  }
}
