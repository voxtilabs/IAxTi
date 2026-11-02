import { DelayedError, type Job, type Processor } from 'bullmq';
import type IORedis from 'ioredis';
import type { ModuleJobData } from '@iaxti/core';

/**
 * La cola de la IA, en paralelo pero DE A UNO POR CONVERSACIÓN (#1214).
 *
 * El problema medido: `createModuleWorker` crea el worker con `{ connection }`
 * y nada más, y el valor por defecto de BullMQ es concurrencia 1. Por esa cola
 * pasan TODAS las respuestas de la IA, así que con la generación en 6,5 s de
 * mediana, diez personas escribiendo juntas dejaban a la última esperando un
 * minuto. Medido: 15,3 s con la cola vacía, 82 s con jobs adelante.
 *
 * Y por qué no alcanza con subir el número: dos mensajes seguidos de la MISMA
 * persona se generarían en paralelo y saldrían dos respuestas que no se
 * conocen entre sí. Eso es peor que la espera — es el defecto de duplicación
 * de siempre entrando por otro lado.
 *
 * Así que la concurrencia es por CONVERSACIÓN y no por job: distintas
 * conversaciones avanzan juntas; la misma, de a una.
 *
 * El segundo mensaje se APLAZA, no se saltea. Saltearlo dejaría sin respuesta
 * a alguien que escribió dos veces seguidas, que es justo lo que hace la
 * gente cuando tiene apuro. `moveToDelayed` + `DelayedError` es el patrón de
 * BullMQ para esto y ya se usa en `queues.ts` para el módulo apagado.
 */

/** Cuánto esperar antes de volver a intentar la misma conversación. */
export const ESPERA_MS = 3_000;
/**
 * Cuánto vive el candado.
 *
 * Tiene que sobrevivir a la generación más lenta —24,4 s fue el peor caso
 * medido— y tiene que caducar solo: si el proceso se muere con el candado
 * tomado, sin vencimiento esa conversación quedaría muda para siempre.
 */
export const CANDADO_MS = 120_000;

export interface Candado {
  /** `true` si lo tomó; `false` si ya estaba tomado. */
  tomar(llave: string, ms: number): Promise<boolean>;
  soltar(llave: string): Promise<void>;
}

export function candadoEnRedis(redis: IORedis): Candado {
  return {
    async tomar(llave, ms) {
      // `NX` lo hace atómico: dos workers que preguntan a la vez no pueden
      // llevárselo los dos. Preguntar y después escribir sí podría.
      return (await redis.set(llave, '1', 'PX', ms, 'NX')) === 'OK';
    },
    async soltar(llave) {
      await redis.del(llave);
    },
  };
}

export function deAUnoPorConversacion(
  candado: Candado,
  procesar: Processor<ModuleJobData>,
): Processor<ModuleJobData> {
  return async (job: Job<ModuleJobData>, token?: string) => {
    const tenantId = job.data.tenantId as string | undefined;
    const conversationId = job.data.conversationId as string | undefined;
    // Un job sin conversación no puede pisar a nadie: pasa directo. Y no se
    // inventa una llave con `undefined` adentro, que serializaría entre sí
    // a jobs que no tienen nada que ver.
    if (!tenantId || !conversationId) return procesar(job, token);

    const llave = `agents:conv:${tenantId}:${conversationId}`;
    if (!(await candado.tomar(llave, CANDADO_MS))) {
      await job.moveToDelayed(Date.now() + ESPERA_MS, token);
      throw new DelayedError();
    }
    try {
      return await procesar(job, token);
    } finally {
      // En `finally` y no al final del `try`: si la generación falla, el
      // candado tiene que soltarse igual. Si no, el siguiente mensaje de esa
      // persona se aplazaría dos minutos por un error que ya pasó.
      await candado.soltar(llave);
    }
  };
}
