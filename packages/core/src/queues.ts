import IORedis from 'ioredis';
import { Queue, Worker, type Processor } from 'bullmq';
import type { ModuleRegistry } from './registry';

/** Las seis colas por naturaleza (SPEC §28). */
export const QUEUE_NAMES = [
  'inbound',
  'outbound',
  'automations',
  'sync',
  'scheduled',
  'agents',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export function redisConnection(url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379') {
  // maxRetriesPerRequest: null es requisito de BullMQ para workers.
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export function createQueue(name: QueueName, connection: IORedis): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    },
  });
}

export interface ModuleJobData {
  /** Módulo dueño del job: apagado ⇒ el job se salta sin error (SPEC §26 regla 5). */
  moduleId?: string;
  [key: string]: unknown;
}

/**
 * Worker que respeta el interruptor de módulos: un job cuyo módulo está
 * apagado se marca saltado y no ejecuta el procesador.
 */
export function createModuleWorker(
  name: QueueName,
  registry: ModuleRegistry,
  processor: Processor<ModuleJobData>,
  connection: IORedis,
): Worker<ModuleJobData> {
  return new Worker<ModuleJobData>(
    name,
    async (job, token) => {
      const moduleId = job.data.moduleId;
      if (moduleId && !registry.isActive(moduleId)) {
        return { skipped: true, reason: `módulo ${moduleId} apagado` };
      }
      return processor(job, token);
    },
    { connection },
  );
}
