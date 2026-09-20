import { api, core, tracing } from '@opentelemetry/sdk-node';
import { wrapSamplingDecision } from '@sentry/opentelemetry';

/** Mantiene el muestreo estándar de OTel al añadir el contexto de Sentry.
 * SentrySampler con tracesSampleRate=0 descartaría también las trazas de Grafana. */
export function samplerConSentry(): tracing.Sampler {
  const env = core.getEnv();
  const name = env.OTEL_TRACES_SAMPLER;
  const value = Number(env.OTEL_TRACES_SAMPLER_ARG);
  const ratio = env.OTEL_TRACES_SAMPLER_ARG?.trim() && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
  let sampler: tracing.Sampler;
  switch (name) {
    case 'always_off': case 'parentbased_always_off': sampler = new tracing.AlwaysOffSampler(); break;
    case 'traceidratio': case 'parentbased_traceidratio': sampler = new tracing.TraceIdRatioBasedSampler(ratio); break;
    case 'always_on': case 'parentbased_always_on': sampler = new tracing.AlwaysOnSampler(); break;
    default:
      api.diag.warn('OTEL_TRACES_SAMPLER inválido; se usa always_on, igual que el SDK.');
      sampler = new tracing.AlwaysOnSampler();
  }
  if (['parentbased_always_on', 'parentbased_always_off', 'parentbased_traceidratio'].includes(name)) sampler = new tracing.ParentBasedSampler({ root: sampler });
  return {
    shouldSample(context, traceId, spanName, spanKind, attributes, links) {
      const result = sampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
      return { ...result, ...wrapSamplingDecision({ decision: result.decision, context, spanAttributes: attributes }) };
    },
    toString: () => `SentryContext(${sampler.toString()})`,
  };
}
