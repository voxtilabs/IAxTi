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
