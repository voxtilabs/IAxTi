import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueEvents } from 'bullmq';
import * as api from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { createModuleWorker, createQueue, redisConnection } from '../src/queues';
import { ModuleRegistry } from '../src/registry';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { conTrazaDelJob } from '@iaxti/telemetry';
import { publishEvent } from '../src/events';

/**
 * UN solo proveedor para todo el archivo. OpenTelemetry registra uno global
 * y el segundo `register()` es un no-op **silencioso**: el segundo test se
 * quedaba mirando un exportador que ya nadie alimentaba y fallaba diciendo
 * "esperaba 2, encontré 0", que no se parece en nada a la causa.
 */
const memoria = new InMemorySpanExporter();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memoria)] }).register();

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
  it('una entrega durable espera al módulo apagado sin completar ni consumir intentos', async () => {
    const registry = fixtureRegistry();
    registry.disable('calendar');
    const connection = redisConnection();
    const queue = createQueue('agents', connection);
    const events = new QueueEvents('agents', { connection: redisConnection() });
    await events.waitUntilReady();
    let calls = 0;
    const worker = createModuleWorker('agents', registry, async () => { calls++; return { ok: true }; }, redisConnection(), { disabled: 'delay' });
    abiertos.push(worker, events, queue, { close: async () => void connection.quit() });
    const delayed = new Promise<void>(resolve => events.once('delayed', () => resolve()));
    const job = await queue.add('espera-modulo', { moduleId: 'calendar' });
    await delayed;
    expect(await job.getState()).toBe('delayed');
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(0);
    expect(calls).toBe(0);
    registry.enable('calendar');
    await job.promote();
    expect(await job.waitUntilFinished(events, 15_000)).toEqual({ ok: true });
    expect(calls).toBe(1);
  }, 30_000);

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
  it('la traza sobrevive al commit del outbox y al nuevo contexto del publicador', async () => {
    const pool = createPool();
    await runMigrations(pool);
    const tenantId = (await pool.query("INSERT INTO tenants (name) VALUES ('outbox-trace') RETURNING id")).rows[0].id;
    const connection = redisConnection();
    const queue = createQueue('outbound', connection);
    abiertos.push(queue, { close: async () => void connection.quit() });
    let rootTrace = '';
    let jobId: string | undefined;
    try {
      await api.trace.getTracer('test').startActiveSpan('request-outbox', async span => {
        rootTrace = span.spanContext().traceId;
        await withTenant(pool, tenantId, async c => {
          await publishEvent(c, { name: 'trace.test', tenantId, payload: { messageId: 'fixture' }, propagateTrace: true });
          // Otro archivo prueba el dispatcher global en paralelo; esta prueba
          // solo transporta el contexto y no debe agregarle trabajo pendiente.
          await c.query('UPDATE outbox SET processed_at=now() WHERE tenant_id=$1', [tenantId]);
        });
        span.end();
      });
      const payload = (await pool.query('SELECT payload FROM outbox WHERE tenant_id=$1', [tenantId])).rows[0].payload;
      expect(Object.keys(payload.__traza)).toEqual(['traceparent']);
      const job = await conTrazaDelJob(payload.__traza, 'publicar-outbox', {}, () => queue.add('trace-test', { moduleId: 'audit' }));
      jobId = job.id;
      expect(job.data.__traza.traceparent.split('-')[1]).toBe(rootTrace);
    } finally {
      if (jobId) await (await queue.getJob(jobId))?.remove();
      await pool.query('DELETE FROM processed_events WHERE event_id IN (SELECT id FROM outbox WHERE tenant_id=$1)', [tenantId]);
      await pool.query('DELETE FROM outbox WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]);
      await pool.end();
    }
  });

  it('el job corre dentro de la traza de quien lo encoló', async () => {
    memoria.reset();

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

describe('encolar en lote (#17)', () => {
  it('addBulk también lleva la traza', async () => {
    memoria.reset();

    const registry = fixtureRegistry();
    const connection = redisConnection();
    const queue = createQueue('inbound', connection);
    const events = new QueueEvents('inbound', { connection: redisConnection() });
    await events.waitUntilReady();

    const worker = createModuleWorker('inbound', registry, async () => ({ ok: true }), redisConnection());
    abiertos.push(worker, events, queue, { close: async () => void connection.quit() });

    const jobs = await api.trace.getTracer('test').startActiveSpan('lote', async (span) => {
      const j = await queue.addBulk([
        { name: 'uno', data: { moduleId: 'audit' } },
        { name: 'dos', data: { moduleId: 'audit' } },
      ]);
      span.end();
      return j;
    });
    for (const j of jobs) await j.waitUntilFinished(events, 15_000);

    const spans = memoria.getFinishedSpans();
    const lote = spans.find((s) => s.name === 'lote')!;
    const hijos = spans.filter((s) => s.name.startsWith('inbound '));
    expect(hijos).toHaveLength(2);
    for (const h of hijos) expect(h.spanContext().traceId).toBe(lote.spanContext().traceId);

  }, 30_000);
});
