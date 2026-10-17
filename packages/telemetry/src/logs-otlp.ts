import type { LoggerProvider } from '@opentelemetry/sdk-logs';

export interface LineaDeLog {
  ts: string; level: string; service: string; msg: string;
  tenant_id?: string; request_id?: string; trace_id?: string; stack?: string;
}

/** Provider propio, sin registrar globales ni instrumentar otra vez console.
 * Solo recibe el sobre ya redactado. No detecta argumentos/env del proceso. */
export function crearTransporteLogs(servicio: string, avisar: (mensaje: string) => void) {
  const modo = process.env.OTEL_LOGS_EXPORTER?.trim();
  if (!modo || modo === 'none') return null;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim() || process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const protocolo = process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL?.trim() || 'http/protobuf';
  let valido = false;
  try { const url = new URL(endpoint || ''); valido = ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { /* configuración inválida */ }
  if (modo !== 'otlp' || process.env.LOG_FORMAT !== 'json' || protocolo !== 'http/protobuf' || !valido) {
    avisar('telemetría: logs OTLP apagados; requieren OTEL_LOGS_EXPORTER=otlp, LOG_FORMAT=json, endpoint HTTP(S) sin credenciales/query y protocolo http/protobuf.');
    return null;
  }
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { LoggerProvider, BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs') as typeof import('@opentelemetry/sdk-logs');
  const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-proto') as typeof import('@opentelemetry/exporter-logs-otlp-proto');
  const { Resource } = require('@opentelemetry/resources') as typeof import('@opentelemetry/resources');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const provider: LoggerProvider = new LoggerProvider({
    resource: new Resource({ 'service.name': `iaxti-${servicio}` }),
    forceFlushTimeoutMillis: 2000,
    logRecordLimits: { attributeCountLimit: 8, attributeValueLengthLimit: 8192 },
  });
  provider.addLogRecordProcessor(new BatchLogRecordProcessor(new OTLPLogExporter({ timeoutMillis: 1000 }), {
    maxQueueSize: 512, maxExportBatchSize: 128, scheduledDelayMillis: 1000, exportTimeoutMillis: 1500,
  }));
  const logger = provider.getLogger('iaxti-console');
  let cerrando: Promise<void> | undefined;
  return {
    emitir(linea: LineaDeLog) {
      if (cerrando) return;
      logger.emit({
        timestamp: new Date(linea.ts),
        severityNumber: linea.level === 'error' ? 17 : linea.level === 'warn' ? 13 : 9,
        severityText: linea.level,
        body: linea.msg,
        attributes: {
          service: linea.service,
          ...(linea.tenant_id ? { tenant_id: linea.tenant_id } : {}),
          ...(linea.request_id ? { request_id: linea.request_id } : {}),
          ...(linea.trace_id ? { trace_id: linea.trace_id } : {}),
          ...(linea.stack ? { 'exception.stacktrace': linea.stack } : {}),
        },
      });
    },
    cerrar() {
      // Dos señales no vuelven a exportar el mismo lote.
      cerrando ||= provider.shutdown().catch(() => avisar('telemetría: no se pudo vaciar la cola de logs OTLP; la salida local se conserva.'));
      return cerrando;
    },
  };
}
