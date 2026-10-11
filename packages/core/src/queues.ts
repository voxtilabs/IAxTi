import IORedis from 'ioredis';
import { DelayedError, Queue, Worker, type JobsOptions, type Processor } from 'bullmq';
import { conContextoDeLog, conTrazaDelJob, contextoDeTraza } from '@iaxti/telemetry';
import { textoDeEntorno } from './entorno';
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

export function redisConnection(url = textoDeEntorno('REDIS_URL', 'redis://127.0.0.1:6379')) {
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
 * Worker que respeta el interruptor de módulos. Por omisión salta el job;
 * las entregas durables optan por aplazarlo hasta que el módulo se reactive.
 */
export function createModuleWorker(
  name: QueueName,
  registry: ModuleRegistry,
  processor: Processor<ModuleJobData>,
  connection: IORedis,
  options: { disabled?: 'skip' | 'delay' } = {},
): Worker<ModuleJobData> {
  return new Worker<ModuleJobData>(
    name,
    async (job, token) => {
      const moduleId = job.data.moduleId;
      if (moduleId && !registry.isActive(moduleId)) {
        if (options.disabled === 'delay') {
          await job.moveToDelayed(Date.now() + 60_000, token);
          throw new DelayedError();
        }
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

/** Una tarea que se repite: nombre, módulo dueño y su pauta. */
export interface Repetible {
  nombre: string;
  moduleId: string;
  repeat: JobsOptions['repeat'];
}

/**
 * Programar los repetibles y COMPROBAR que quedaron programados.
 *
 * ## Qué estaba mal
 *
 * El arranque hacía `void Promise.all([...]).catch(err => console.error(…))`,
 * sin `await`, y en la línea siguiente imprimía «workers: worker de cola
 * scheduled activo» pase lo que pase. Si Redis tosía en el arranque, se
 * programaban CERO repetibles, el error quedaba en un `console.error` entre
 * cientos de líneas, y el proceso seguía vivo diciendo que estaba activo.
 *
 * El runbook de producción manda a comprobar esto mirando dos líneas del log
 * —«despachador de outbox activo» y las colas declaradas— y las dos se
 * imprimen igual con cero repetibles: una 400 líneas ANTES de la
 * programación, la otra justo después y sin preguntar. **La comprobación del
 * §4 no podía ver el fallo que el §4 existe para evitar** (#807).
 *
 * Y lo que se cae es lo que el negocio da por hecho: la prueba gratis no
 * termina, el impago no suspende, `conversations.retention` no purga —que el
 * propio runbook marca como compromiso legal— y `api_usage.flush` no cobra el
 * consumo de API.
 *
 * ## Qué hace ahora
 *
 * Programa, vuelve a LEER de Redis qué quedó, y compara contra la lista. Lo
 * que falte se nombra. Devuelve los nombres programados para que el arranque
 * los imprima: un log que dice «18 tareas programadas» y las lista es algo
 * que un operador puede comprobar, y es la diferencia entre una señal y un
 * adorno.
 */
export async function programarRepetibles(
  cola: Queue,
  repetibles: Repetible[],
): Promise<string[]> {
  await Promise.all(
    repetibles.map((r) => cola.add(r.nombre, { moduleId: r.moduleId }, { repeat: r.repeat })),
  );
  const programados = new Set((await cola.getJobSchedulers()).map((s) => s.name));
  const faltan = repetibles.map((r) => r.nombre).filter((n) => !programados.has(n));
  if (faltan.length > 0) {
    throw new Error(
      `no quedaron programados ${faltan.length} de ${repetibles.length} repetibles: ${faltan.join(', ')}`,
    );
  }
  return repetibles.map((r) => r.nombre);
}
