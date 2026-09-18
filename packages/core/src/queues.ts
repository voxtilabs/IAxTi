import IORedis from 'ioredis';
import { Queue, Worker, type Processor } from 'bullmq';
import { conContextoDeLog, conTrazaDelJob, contextoDeTraza } from '@iaxti/telemetry';
import type { ModuleRegistry } from './registry';

/**
 * Dónde viaja la traza dentro del job (#17). El nombre lleva guiones bajos
 * a propósito: es del sobre, no del negocio, y ningún consumidor debería
 * leerlo. Es W3C `traceparent`, el mismo formato que va en las cabeceras
 * HTTP.
 */
const LLAVE_TRAZA = '__traza';

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
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    },
  });

  // La traza se pega al encolar, en el ÚNICO lugar por donde pasan todos:
  // pedírselo a cada `queue.add` del código sería pedir que nadie se olvide
  // nunca, y alguien se olvida siempre. El job que se encola sin traza
  // activa —un barrido programado, por ejemplo— viaja sin ella y arranca la
  // suya, que es lo correcto: no tiene request del cual colgar.
  const conTraza = (data: unknown): unknown => {
    const traza = contextoDeTraza();
    return Object.keys(traza).length && data && typeof data === 'object'
      ? { ...(data as Record<string, unknown>), [LLAVE_TRAZA]: traza }
      : data;
  };

  const add = queue.add.bind(queue);
  queue.add = ((nombre: string, data: unknown, opts?: unknown) =>
    add(nombre, conTraza(data) as never, opts as never)) as typeof queue.add;

  // `addBulk` también, aunque hoy no lo use nadie. Si mañana alguien encola
  // en lote y esto no estuviera, la traza se perdería en silencio — y un
  // agujero silencioso en la observabilidad es justo lo que no se descubre
  // hasta que hace falta.
  const addBulk = queue.addBulk.bind(queue);
  queue.addBulk = ((trabajos: Array<{ name: string; data: unknown; opts?: unknown }>) =>
    addBulk(
      trabajos.map((t) => ({ ...t, data: conTraza(t.data) })) as never,
    )) as typeof queue.addBulk;

  return queue;
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
      // El job sigue la traza del request que lo encoló. El tenant va como
      // atributo: sin él, una latencia alta es un número sin dueño y no se
      // puede saber a quién le está yendo mal.
      return conTrazaDelJob(
        job.data[LLAVE_TRAZA] as Record<string, string> | undefined,
        `${name} ${job.name}`,
        {
          'messaging.system': 'bullmq',
          'messaging.destination.name': name,
          'iaxti.job': job.name,
          'iaxti.module': moduleId,
          'iaxti.tenant_id': job.data.tenantId as string | undefined,
          'iaxti.request_id': job.data.requestId as string | undefined,
        },
        // El mismo tenant que va en el span va en cada log que el job
        // escriba: si están en sistemas distintos y no comparten la llave,
        // cruzarlos a mano es lo que nadie hace a las 3 de la mañana.
        () =>
          conContextoDeLog(
            {
              tenantId: job.data.tenantId as string | undefined,
              requestId: job.data.requestId as string | undefined,
            },
            () => Promise.resolve(processor(job, token)),
          ),
      );
    },
    { connection },
  );
}
