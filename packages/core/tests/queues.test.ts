import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueEvents } from 'bullmq';
import { createModuleWorker, createQueue, redisConnection } from '../src/queues';
import { ModuleRegistry } from '../src/registry';

function fixtureRegistry(): ModuleRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'iaxti-queues-'));
  const mods: Record<string, string> = {
    identity: `module: { id: identity, version: 0.1.0, core: true }\n`,
    organizations: `module: { id: organizations, version: 0.1.0, core: true }\ndepends_on: { required: [identity] }\n`,
    authorization: `module: { id: authorization, version: 0.1.0, core: true }\ndepends_on: { required: [identity, organizations] }\n`,
    audit: `module: { id: audit, version: 0.1.0, core: true }\ndepends_on: { required: [identity, organizations] }\n`,
    calendar: `module: { id: calendar, version: 0.1.0 }\n`,
  };
  for (const [id, yaml] of Object.entries(mods)) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'module.yaml'), yaml);
  }
  return new ModuleRegistry(dir).load();
}

const abiertos: Array<{ close: () => Promise<void> }> = [];

afterAll(async () => {
  for (const recurso of abiertos.reverse()) await recurso.close();
});

describe('colas BullMQ', () => {
  it('un job se procesa y otro de un módulo apagado se salta', async () => {
    const registry = fixtureRegistry();
    registry.disable('calendar');

    const connection = redisConnection();
    const queue = createQueue('scheduled', connection);
    const events = new QueueEvents('scheduled', { connection: redisConnection() });
    await events.waitUntilReady();

    const procesados: string[] = [];
    const worker = createModuleWorker(
      'scheduled',
      registry,
      async (job) => {
        procesados.push(job.name);
        return { ok: true };
      },
      redisConnection(),
    );
    abiertos.push(worker, events, queue, { close: async () => void connection.quit() });

    const activo = await queue.add('job-audit', { moduleId: 'audit' });
    const apagado = await queue.add('job-calendar', { moduleId: 'calendar' });

    const resultadoActivo = await activo.waitUntilFinished(events, 15_000);
    const resultadoApagado = await apagado.waitUntilFinished(events, 15_000);

    expect(resultadoActivo).toEqual({ ok: true });
    expect(resultadoApagado).toEqual({ skipped: true, reason: 'módulo calendar apagado' });
    expect(procesados).toEqual(['job-audit']);
  }, 30_000);
});

describe('la traza cruzando la cola (#17)', () => {
  it('el job corre dentro de la traza de quien lo encoló', async () => {
    const api = await import('@opentelemetry/api');
    const { NodeTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import(
      '@opentelemetry/sdk-trace-node'
    );
    const memoria = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memoria)] });
    provider.register();

    const registry = fixtureRegistry();
    const connection = redisConnection();
    const queue = createQueue('sync', connection);
    const events = new QueueEvents('sync', { connection: redisConnection() });
    await events.waitUntilReady();

    const worker = createModuleWorker('sync', registry, async () => ({ ok: true }), redisConnection());
    abiertos.push(worker, events, queue, { close: async () => void connection.quit() });

    // Un "request": todo lo que pase adentro cuelga de este span.
    const job = await api.trace
      .getTracer('test')
      .startActiveSpan('request-de-mentira', async (span) => {
        const j = await queue.add('job-con-traza', { moduleId: 'audit', tenantId: 't-123' });
        span.end();
        return j;
      });
    await job.waitUntilFinished(events, 15_000);

    const spans = memoria.getFinishedSpans();
    const request = spans.find((s) => s.name === 'request-de-mentira');
    const trabajo = spans.find((s) => s.name === 'sync job-con-traza');

    expect(request).toBeDefined();
    expect(trabajo).toBeDefined();
    // Esto es lo que se pedía: UNA traza desde el request hasta el job. Sin
    // la propagación, el worker abre una traza nueva y estos dos ids son
    // distintos — que es como estaba.
    expect(trabajo!.spanContext().traceId).toBe(request!.spanContext().traceId);
    expect(trabajo!.attributes['iaxti.tenant_id']).toBe('t-123');

    await provider.shutdown();
  }, 30_000);

  it('un job encolado sin traza activa no se rompe: arranca la suya', async () => {
    const registry = fixtureRegistry();
    const connection = redisConnection();
    const queue = createQueue('automations', connection);
    const events = new QueueEvents('automations', { connection: redisConnection() });
    await events.waitUntilReady();

    let vioLaLlave = false;
    const worker = createModuleWorker(
      'automations',
      registry,
      async (job) => {
        // El sobre no ensucia los datos del negocio: si un consumidor
        // empezara a ver `__traza` entre sus campos, terminaría leyéndolo.
        vioLaLlave = '__traza' in job.data;
        return { ok: true };
      },
      redisConnection(),
    );
    abiertos.push(worker, events, queue, { close: async () => void connection.quit() });

    const job = await queue.add('barrido', { moduleId: 'audit' });
    await job.waitUntilFinished(events, 15_000);
    expect(vioLaLlave).toBe(false);
  }, 30_000);
});
