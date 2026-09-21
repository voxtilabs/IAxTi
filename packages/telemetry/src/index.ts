import { AsyncLocalStorage } from 'node:async_hooks';
import * as Sentry from '@sentry/node';
export { frontendReadiness } from './frontend-readiness';

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
/**
 * El release, sacado de la referencia de la imagen que está corriendo.
 *
 * Llega como `ghcr.io/voxtilabs/iaxti:<sha>` o `:vX.Y.Z`, y lo que Sentry
 * necesita es la etiqueta. Se saca del ÚLTIMO `:` para no romperse con un
 * registro que traiga puerto (`registro:5000/imagen:tag`).
 *
 * Sin la variable devuelve undefined y Sentry sigue funcionando: un error
 * sin release es malo, arrancar roto por eso sería peor.
 */
export function releaseDeLaImagen(imagen = process.env.IAXTI_IMAGE): string | undefined {
  const ref = imagen?.trim();
  if (!ref) return undefined;
  const i = ref.lastIndexOf(':');
  // Sin `:` no hay etiqueta, y si el `:` está antes del último `/` es el
  // puerto del registro, no una etiqueta.
  if (i < 0 || i < ref.lastIndexOf('/')) return undefined;
  const tag = ref.slice(i + 1);
  return tag && tag !== 'latest' ? tag : undefined;
}

export function initObservability(serviceName: string): void {
  activarLogsEstructurados(serviceName);

  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.IAXTI_ENV ?? 'local',
      serverName: serviceName,
      // De qué versión viene el error (#392). Sin esto, en Sentry todos se
      // ven iguales vengan del deploy de hace cinco minutos o del de la
      // semana pasada, y además nunca marca una regresión: para eso compara
      // releases.
      //
      // El identificador ya existía y es exacto —la imagen se fija por SHA
      // del commit y `release.yml` promueve la del commit que se taguea—,
      // solo no llegaba al proceso. `undefined` y no una cadena inventada:
      // un release falso agrupa mal, que es peor que no agrupar.
      release: releaseDeLaImagen(),
      // Un solo dueño de los globales. Sin tracesSampleRate, Sentry no
      // activa sus integraciones de rendimiento (0 también las activaba).
      // En conjunto, NodeSDK registra el contexto y exporta solo a OTLP.
      skipOpenTelemetrySetup: Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT),
      integrations: [Sentry.httpIntegration({ spans: false })],
    });
  }

  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    // Antes de arrancar nada: si la configuración está mal, decirlo. El SDK
    // no se queja — manda contra un colector que rechaza y los tableros
    // quedan vacíos, que se lee igual que "no pasó nada".
    for (const p of revisarConfigOtel()) {
      console.error(
        `telemetría: ${p.variable} ${p.problema}\n` +
          '            Las trazas NO se están exportando. El servicio sigue igual.',
      );
    }
    hacerVisiblesLosFallosDeOtel();
    // Import diferido: el SDK de OTel es pesado y solo se paga si está activo.
    // El exportador OTLP y sus cabeceras salen de las variables estándar
    // OTEL_EXPORTER_OTLP_* que el SDK lee solo.
    process.env.OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? `iaxti-${serviceName}`;
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { NodeSDK } = require('@opentelemetry/sdk-node') as typeof import('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } =
      require('@opentelemetry/auto-instrumentations-node') as typeof import('@opentelemetry/auto-instrumentations-node');
    /* eslint-enable @typescript-eslint/no-require-imports */

    // Sentry conserva aislamiento y propagación; no se agrega su
    // SpanProcessor, porque las trazas van a Grafana (ADR-0006).
    const conSentry = Boolean(process.env.SENTRY_DSN);
    /* eslint-disable @typescript-eslint/no-require-imports */
    const sentryOtel = conSentry ? require('@sentry/opentelemetry') as typeof import('@sentry/opentelemetry') : null;
    const sampler = conSentry ? (require('./sampler-sentry') as typeof import('./sampler-sentry')).samplerConSentry() : undefined;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const sdk = new NodeSDK({
      ...(sentryOtel ? {
        contextManager: new Sentry.SentryContextManager(),
        textMapPropagator: new sentryOtel.SentryPropagator(),
        sampler,
      } : {}),
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

/**
 * El contexto que acompaña a cada línea de log (#17, SPEC §14).
 *
 * El criterio pedía `tenant_id` en los logs estructurados. Los 39 mensajes
 * que hay están escritos para que los lea una persona ("scheduled: 3 reglas
 * y 2 pasos de secuencia") y eso está bien: en la terminal, durante el
 * desarrollo, un JSON de doce campos es peor.
 *
 * Así que no se reescriben. Lo que cambia es el SOBRE: con `LOG_FORMAT=json`
 * —producción— cada línea sale como un objeto con el mensaje adentro y el
 * tenant, el request y la traza alrededor. Sin esa variable, la terminal se
 * ve exactamente igual que hoy.
 */

export interface ContextoDeLog {
  tenantId?: string;
  requestId?: string;
  servicio?: string;
}

const almacen = new AsyncLocalStorage<ContextoDeLog>();

/** Todo lo que se loguee dentro de `fn` lleva este contexto. */
export function conContextoDeLog<T>(datos: ContextoDeLog, fn: () => T): T {
  const previo = almacen.getStore();
  return almacen.run({ ...previo, ...datos }, fn);
}

export function contextoDeLogActual(): ContextoDeLog {
  return almacen.getStore() ?? {};
}

/**
 * Agrega datos al contexto vigente sin abrir uno nuevo. Es para lo que se
 * averigua a mitad de camino: el tenant de un request se sabe recién cuando
 * el guard resuelve quién llama, y para entonces el middleware ya pasó.
 */
export function agregarAlContextoDeLog(datos: ContextoDeLog): void {
  const actual = almacen.getStore();
  if (actual) Object.assign(actual, datos);
}

const NIVELES = ['log', 'warn', 'error'] as const;

/**
 * Marca en la función envuelta. Con un booleano de módulo, envolver dos
 * veces era imposible pero *desenvolver* pasaba desapercibido: si algo
 * reemplaza `console` después de nosotros, la marca lo delata y se vuelve a
 * envolver en la siguiente llamada.
 */
const ENVUELTO = Symbol.for('iaxti.log.envuelto');

/**
 * Envuelve `console` para que cada línea salga como JSON con su contexto.
 *
 * Se envuelve `console` en vez de cambiar los 39 sitios que loguean porque
 * cambiar los sitios es pedir que nadie se olvide nunca de pasar el tenant
 * — y el que se olvide no va a fallar, va a loguear sin tenant, que es
 * justamente lo que no se nota.
 */
export function activarLogsEstructurados(servicio: string): void {
  if (process.env.LOG_FORMAT !== 'json') return;

  for (const nivel of NIVELES) {
    const actual = console[nivel] as ((...a: unknown[]) => void) & { [ENVUELTO]?: true };
    if (actual[ENVUELTO]) continue;
    const original = actual.bind(console);
    const envuelto = (...args: unknown[]) => {
      const ctx = contextoDeLogActual();
      const linea = {
        ts: new Date().toISOString(),
        level: nivel === 'log' ? 'info' : nivel,
        service: ctx.servicio ?? servicio,
        msg: args
          .map((a) => (a instanceof Error ? `${a.message}` : typeof a === 'string' ? a : safeJson(a)))
          .join(' '),
        ...(ctx.tenantId ? { tenant_id: ctx.tenantId } : {}),
        ...(ctx.requestId ? { request_id: ctx.requestId } : {}),
        ...(trazaActual() ? { trace_id: trazaActual() } : {}),
        // El stack completo solo cuando lo hay: una línea de info con
        // `stack: undefined` ensucia todas las demás.
        ...(args.find((a) => a instanceof Error)
          ? { stack: (args.find((a) => a instanceof Error) as Error).stack }
          : {}),
      };
      original(JSON.stringify(linea));
    };
    (envuelto as typeof envuelto & { [ENVUELTO]: true })[ENVUELTO] = true;
    console[nivel] = envuelto;
  }
}

function safeJson(valor: unknown): string {
  try {
    return JSON.stringify(valor);
  } catch {
    // Un objeto con ciclos no puede tumbar un log. Perder el detalle es
    // molesto; perder la línea entera es quedarse sin saber qué pasó.
    return String(valor);
  }
}

// ── La telemetría que no exporta y no lo dice (#17) ─────────────────────

export interface ProblemaDeConfig {
  variable: string;
  problema: string;
}

/**
 * Revisa la configuración de OTel ANTES de arrancar el exportador.
 *
 * El SDK lee `OTEL_EXPORTER_OTLP_*` solo, y si el valor está mal no falla:
 * arranca igual, manda, el colector responde 401 y ese 401 no aparece en
 * ningún lado. La telemetría queda apagada y los tableros vacíos se leen como
 * "no pasó nada", que es la peor forma de estar ciego — parece que todo anda
 * bien.
 *
 * El caso concreto que lo destapó: en staging la cabecera era
 *
 *     OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic
 *
 * «Basic» sin la credencial detrás. Sintaxis válida para el parser del SDK,
 * credencial vacía para Grafana. Rechaza todo y nadie se entera.
 *
 * Esto NO tumba el servicio: quedarse sin trazas es malo, quedarse sin
 * producto es peor. Avisa fuerte y sigue.
 */
export function revisarConfigOtel(env: NodeJS.ProcessEnv = process.env): ProblemaDeConfig[] {
  const problemas: ProblemaDeConfig[] = [];
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return problemas; // apagado a propósito: no es un problema

  if (!/^https?:\/\//.test(endpoint)) {
    problemas.push({
      variable: 'OTEL_EXPORTER_OTLP_ENDPOINT',
      problema: `tiene que empezar con http:// o https:// y dice "${endpoint}".`,
    });
  }

  const crudas = env.OTEL_EXPORTER_OTLP_HEADERS;
  if (crudas !== undefined && crudas.trim() !== '') {
    for (const par of crudas.split(',')) {
      const i = par.indexOf('=');
      if (i <= 0) {
        problemas.push({
          variable: 'OTEL_EXPORTER_OTLP_HEADERS',
          problema: `"${par.trim()}" no tiene forma nombre=valor.`,
        });
        continue;
      }
      const nombre = par.slice(0, i).trim();
      const valor = par.slice(i + 1).trim();
      if (valor === '') {
        problemas.push({
          variable: 'OTEL_EXPORTER_OTLP_HEADERS',
          problema: `la cabecera "${nombre}" va vacía.`,
        });
        continue;
      }
      // Una autorización que es solo el esquema es el caso real: pasa el
      // parser y el colector la rechaza. Sin esta comprobación el error se
      // ve idéntico a "todo bien pero no hay tráfico".
      if (nombre.toLowerCase() === 'authorization' && /^(basic|bearer)$/i.test(valor)) {
        problemas.push({
          variable: 'OTEL_EXPORTER_OTLP_HEADERS',
          problema:
            `"Authorization=${valor}" trae el esquema sin la credencial. Va ` +
            `"Authorization=${valor} <credencial>", y el colector rechaza TODO hasta que esté.`,
        });
      }
    }
  }
  return problemas;
}

/**
 * Hace visibles los fallos del exportador.
 *
 * Sin esto, un 401 o un endpoint caído no dejan rastro: el SDK los manda a su
 * canal de diagnóstico, que por defecto no va a ninguna parte. Con esto, un
 * rechazo del colector sale por el log como cualquier otro error — que es lo
 * único que permite darse cuenta el día que la credencial rote.
 */
function hacerVisiblesLosFallosDeOtel(): void {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const api = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
    /* eslint-enable @typescript-eslint/no-require-imports */
    api.diag.setLogger(
      {
        error: (msg, ...args) => console.error(`otel: ${msg}`, ...args),
        warn: (msg, ...args) => console.warn(`otel: ${msg}`, ...args),
        // info/debug/verbose se quedan callados: el SDK es conversador y lo
        // que hace falta saber es cuándo NO pudo mandar.
        info: () => {},
        debug: () => {},
        verbose: () => {},
      },
      api.DiagLogLevel.WARN,
    );
  } catch {
    /* sin el paquete de api no hay nada que enganchar */
  }
}
