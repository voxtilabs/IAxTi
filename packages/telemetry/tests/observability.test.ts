import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ejecutar = promisify(execFile);

describe('Sentry y OTLP en procesos reales (#369)', () => {
  it.each([
    { sentry: false, otel: false, sampler: 'parentbased_always_on' },
    { sentry: true, otel: false, sampler: 'parentbased_always_on' },
    { sentry: false, otel: true, sampler: 'parentbased_always_on' },
    { sentry: true, otel: true, sampler: 'parentbased_always_on' },
    { sentry: true, otel: true, sampler: 'always_off' },
    { sentry: true, otel: true, sampler: 'parentbased_always_off' },
    { sentry: true, otel: true, sampler: 'traceidratio' },
    { sentry: true, otel: true, sampler: 'parentbased_traceidratio' },
  ])('Sentry=$sentry OTLP=$otel sampler=$sampler', async ({ sentry, otel, sampler }) => {
    const requests: Array<{ path: string; body: string }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        requests.push({ path: req.url ?? '', body: (req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString() });
        res.setHeader('Content-Type', 'application/json');
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { stdout, stderr } = await ejecutar(process.execPath, [join(__dirname, 'fixtures/observability.cjs')], {
        timeout: 20_000,
        env: {
          ...process.env,
          SENTRY_DSN: sentry ? `http://public@127.0.0.1:${port}/1` : '',
          OTEL_EXPORTER_OTLP_ENDPOINT: otel ? `http://127.0.0.1:${port}` : '',
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
          OTEL_EXPORTER_OTLP_HEADERS: '',
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
          OTEL_TRACES_SAMPLER: sampler,
          OTEL_TRACES_SAMPLER_ARG: '0',
          OTEL_BSP_SCHEDULE_DELAY: '10',
          OTEL_METRICS_EXPORTER: 'none',
          OTEL_LOGS_EXPORTER: 'none',
          LOG_FORMAT: '',
        },
      });
      expect(stderr).not.toContain('duplicate registration');
      const resultados = JSON.parse(stdout.trim().split('\n').at(-1)!) as Array<{ tenant: string; carrier: Record<string, string> }>;
      const traces = requests.filter((r) => r.path === '/v1/traces').flatMap((r) => {
        const body = JSON.parse(r.body);
        return body.resourceSpans.flatMap((resource: { scopeSpans: Array<{ spans: Array<{ name: string; traceId: string; spanId: string; parentSpanId?: string }> }> }) => resource.scopeSpans.flatMap((scope) => scope.spans));
      });
      const root = traces.find((span) => span.name === 'root-uno');
      if (otel && sampler === 'parentbased_always_on') {
        expect(root, `No se exportó la traza de plataforma. stderr=${stderr}`).toBeDefined();
        const child = traces.find((span) => span.name === 'child-uno');
        expect(child.traceId).toBe(root.traceId);
        expect(child.parentSpanId).toBe(root.spanId);
        expect(resultados[0].carrier.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
      } else expect(traces).toEqual([]);
      const envelopes = requests.filter((r) => r.path.includes('/envelope/')).flatMap((r) => r.body.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
      const errores = envelopes.filter((e) => e.exception);
      expect(errores).toHaveLength(sentry ? 2 : 0);
      expect(envelopes.some((e) => e.type === 'transaction')).toBe(false);
      for (const tenant of sentry ? ['uno', 'dos'] : []) {
        const error = errores.find((e) => e.exception.values[0].value === `local-${tenant}`);
        expect(error.tags.test_tenant).toBe(tenant);
        expect(error.extra.requestId).toBe(`req_${tenant}`);
        if (otel && sampler === 'parentbased_always_on') {
          expect(error.contexts.trace.trace_id).toBe(traces.find((span) => span.name === `root-${tenant}`).traceId);
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 25_000);
});
