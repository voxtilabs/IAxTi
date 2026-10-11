import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Que el proveedor de MÉTRICAS exista de verdad (#17).
 *
 * ## El defecto que esta prueba fija, y por qué nadie lo vio
 *
 * `@opentelemetry/sdk-node` crea el MeterProvider **solo si el `NodeSDK` recibe
 * `metricReader` o `views`** (`build/src/sdk.js:112-115`). El nuestro no recibía
 * ninguno de los dos, así que el proceso corría con el proveedor NO-OP: cada
 * `meter.createCounter(...)` devolvía un instrumento que no registra nada, sin
 * un solo error ni un aviso.
 *
 * Lo que hizo que durara: **las trazas sí salían.** El panel de Grafana tenía
 * datos, el issue #17 afirmaba «OTel → Grafana Cloud» y lo cableado era la
 * mitad. Y la mitad que faltaba es la que se usa para alertar: una alerta sobre
 * una métrica que no existe no falla — no hay serie, así que no dispara nunca.
 *
 * ## Por qué se mira el PROVEEDOR y no una métrica concreta
 *
 * Afirmar «la métrica X tiene valor» exigiría provocar tráfico y esperar el
 * intervalo de exportación, y eso mide el reloj. Lo que no envejece es la
 * propiedad: que el proveedor global NO sea el no-op. Si alguien vuelve a
 * quitar el `metricReader`, esto se pone rojo sin depender de ninguna
 * instrumentación en particular.
 */
/**
 * Se intercepta el MÓDULO y no el export.
 *
 * `vi.spyOn(Sentry, 'captureException')` falla con «Module namespace is not
 * configurable in ESM»: un namespace de ESM es inmutable, así que no hay dónde
 * poner el espía. `vi.mock` reemplaza el módulo antes de que alguien lo importe,
 * que es el único punto donde todavía se puede.
 */
const capturado: Array<{ error: unknown; extra: Record<string, unknown> }> = [];
vi.mock('@sentry/node', () => ({
  captureException: (e: unknown, o?: { extra?: Record<string, unknown> }) => {
    capturado.push({ error: e, extra: o?.extra ?? {} });
    return 'id-de-prueba';
  },
  init: () => {},
  flush: async () => true,
  SentryContextManager: class {},
}));

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe('las métricas salen de verdad (#17)', () => {
  it('con OTel activo, el proveedor de métricas NO es el no-op', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otlp.example.invalid';
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
    delete process.env.SENTRY_DSN;

    const { initObservability } = await import('../src/index');
    initObservability('prueba-metricas');

    const { metrics } = await import('@opentelemetry/api');
    const proveedor = metrics.getMeterProvider();

    /**
     * El no-op se reconoce por su NOMBRE de clase y no por una marca: la API de
     * OTel no expone «¿sos el no-op?», y comparar contra la instancia exportada
     * falla cuando hay dos copias de `@opentelemetry/api` en el árbol — que es
     * exactamente lo que pasa en un monorepo con pnpm.
     */
    expect(proveedor.constructor.name).not.toBe('NoopMeterProvider');

    // Y que un instrumento creado desde ahí sea real, no un hueco.
    const contador = proveedor.getMeter('prueba').createCounter('prueba_total');
    expect(contador.constructor.name).not.toBe('NoopCounter');
  });

  it('avisa si el entorno pide un protocolo que las métricas no van a usar', async () => {
    // Las trazas siguen `OTEL_EXPORTER_OTLP_PROTOCOL`; las métricas van por
    // http/protobuf. Si no coinciden, el reparto lo decidió nadie y aparece
    // como «faltan series» en un panel, lejos de la causa.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otlp.example.invalid';
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    delete process.env.SENTRY_DSN;
    const avisos: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => void avisos.push(String(a[0])));

    const { initObservability } = await import('../src/index');
    initObservability('prueba-protocolo');
    warn.mockRestore();

    expect(avisos.some((a) => a.includes('http/protobuf') && a.includes('grpc'))).toBe(true);
  });

  it('una variable DECLARADA EN BLANCO no se trata como un protocolo raro (#575)', async () => {
    // El compose pasa `${OTEL_EXPORTER_OTLP_PROTOCOL}` pelada, sin `:-`, así que
    // una variable de proyecto sin valor llega como `''`. Avisar ahí sería
    // gritar en cada arranque de un despliegue correctamente configurado — y una
    // guarda que grita de más se apaga igual de rápido que una que no grita.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otlp.example.invalid';
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = '';
    delete process.env.SENTRY_DSN;
    const avisos: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => void avisos.push(String(a[0])));

    const { initObservability } = await import('../src/index');
    initObservability('prueba-blanco');
    warn.mockRestore();

    expect(avisos.some((a) => a.includes('OTEL_EXPORTER_OTLP_PROTOCOL'))).toBe(false);
  });
});

/**
 * Los errores del servidor de Next llegan a Sentry (#17).
 *
 * `Sentry.init` corría en `web` y en `admin` y ninguna exportaba
 * `onRequestError`, que en Next 15 es el gancho por el que pasan los fallos del
 * SERVIDOR. Sin él esos errores se quedan en el log del contenedor: la pantalla
 * que se cae del lado servidor no generaba ningún aviso, mientras los del
 * navegador sí — lo que da la impresión de que el front no falla.
 */
describe('los errores de servidor de Next llegan a Sentry (#17)', () => {
  it('manda la RUTA y el requestId, y NO la URL ni el tenant', async () => {
    process.env.SENTRY_DSN = 'https://llave@sentry.example.invalid/1';
    const { errorDeRequestDeNext } = await import('../src/index');

    errorDeRequestDeNext(
      new Error('se cayó el render'),
      {
        path: '/conversations/7f3a9c21-0000-4000-8000-000000000000',
        method: 'GET',
        headers: { 'x-request-id': 'req_abc', 'x-tenant-id': 'tenant-secreto' },
      },
      { routerKind: 'App Router', routePath: '/conversations/[id]', routeType: 'render' },
    );

    expect(capturado).toHaveLength(1);
    const { extra } = capturado[0];
    // La RUTA, no la URL con el id adentro: una URL lleva ids y a veces datos
    // del cliente en la query, y esto va a un proveedor externo.
    expect(extra.ruta).toBe('/conversations/[id]');
    // El requestId sí, porque es lo que ata el aviso con nuestros logs y la traza.
    expect(extra.requestId).toBe('req_abc');
    // Y el tenant NO: iría a un proveedor externo sin que nadie lo decidiera, y
    // el requestId ya alcanza para encontrarlo en nuestro libro.
    expect(JSON.stringify(extra)).not.toContain('tenant-secreto');
  });

  it('sin SENTRY_DSN no manda nada: apagado, no roto', async () => {
    delete process.env.SENTRY_DSN;
    capturado.length = 0;
    const { errorDeRequestDeNext } = await import('../src/index');
    errorDeRequestDeNext(new Error('x'), {}, {});
    expect(capturado).toEqual([]);
  });
});
