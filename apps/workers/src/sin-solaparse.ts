/**
 * Que una pasada de un barrido no se pise con la anterior.
 *
 * La cola `scheduled` pasó a correr en paralelo, y eso era necesario: con
 * concurrencia 1 los repetibles «cada minuto» no eran cada minuto, porque uno
 * solo lento los atrasaba a todos. Pero con concurrencia > 1 BullMQ puede
 * arrancar la pasada siguiente de un repetible antes de que termine la anterior,
 * y dos `calendar.reminders` a la vez mandan el mismo recordatorio dos veces.
 *
 * Esto vive en su propio archivo por un motivo que vale escribir: la primera
 * versión del guardián estaba dentro del closure de `main.ts` y su prueba era
 * `expect(MAIN).toContain('enCurso.has(llave)')`. Esa prueba pasa con el cuerpo
 * del `if` vacío, pasa sin el `enCurso.add`, y se pone roja cuando alguien
 * reformatea `main.ts` sin tocar nada. O sea: no probaba el mecanismo y sí
 * generaba conflictos. Acá se puede llamar dos veces a la vez y ver qué pasa,
 * que es la única forma de saber si sirve.
 *
 * Son DOS candados y los dos hacen falta:
 *
 * - **En memoria**, instantáneo, para el solapamiento dentro de este proceso,
 *   que es el caso normal con concurrencia 5.
 * - **En Redis**, para el solapamiento ENTRE procesos. Hoy corre una sola
 *   réplica, así que es tentador saltárselo — pero el momento en que dos
 *   procesos coexisten es precisamente el despliegue: el contenedor viejo drena
 *   sus jobs mientras el nuevo arranca. Y es el peor momento para duplicar,
 *   porque en esta cola viven `knowledge.reindex` —que le paga al proveedor de
 *   embeddings por fuente— y `conversations.retention.tenant`, que borra en R2
 *   y no se puede deshacer. `dispatcher.ts` ya asume multi-proceso
 *   explícitamente (FOR UPDATE SKIP LOCKED), así que la suposición de «una sola
 *   réplica» no es de este repo.
 */

/** Lo que el guardián necesita de Redis, y nada más. */
export interface CandadoCompartido {
  /** true si lo tomó; false si otro proceso lo tiene. */
  tomar(llave: string, ttlMs: number): Promise<boolean>;
  /** Solo suelta lo que tomó: si el TTL venció y otro lo tomó, no se lo quita. */
  soltar(llave: string): Promise<void>;
}

/**
 * Cuánto puede durar el candado compartido antes de soltarse solo.
 *
 * Existe porque un proceso que muere con el candado tomado no lo suelta, y sin
 * TTL el barrido quedaría bloqueado para siempre. El número es un compromiso
 * explícito: más corto y una pasada lenta de verdad se solapa consigo misma;
 * más largo y un proceso caído detiene el barrido por ese rato. Quince minutos
 * es más que cualquier pasada observada y menos que la paciencia de nadie.
 */
export const CANDADO_TTL_MS = 15 * 60 * 1000;

/** El sobre que ya usa `createModuleWorker` para el módulo apagado. */
export interface Saltado {
  skipped: true;
  reason: string;
}

/**
 * El candado en Redis, con la única sutileza que tiene: soltar comprueba que el
 * valor siga siendo el nuestro. Sin eso, una pasada que se pasó del TTL le
 * quitaría el candado a la pasada siguiente al terminar.
 */
export function candadoEnRedis(redis: {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttl: number,
    nx: 'NX',
  ): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}): CandadoCompartido {
  // Uno por proceso: es lo que distingue "mi candado" del de la otra réplica.
  const mio = `${process.pid}:${Math.floor(performance.now())}`;
  const tomados = new Map<string, string>();
  return {
    async tomar(llave, ttlMs) {
      const valor = `${mio}:${llave}`;
      const r = await redis.set(`candado:scheduled:${llave}`, valor, 'PX', ttlMs, 'NX');
      if (r === null) return false;
      tomados.set(llave, valor);
      return true;
    },
    async soltar(llave) {
      const valor = tomados.get(llave);
      if (valor === undefined) return;
      tomados.delete(llave);
      await redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        1,
        `candado:scheduled:${llave}`,
        valor,
      );
    },
  };
}

/**
 * Envuelve el trabajo de la cola `scheduled` para que una pasada no se pise con
 * la anterior, ni acá ni en otro proceso.
 *
 * Se SALTA, no se reencola: estos barridos son idempotentes y la próxima pasada
 * agarra lo que quedó. Reencolarlo acumularía pasadas de un trabajo que ya va
 * atrasado.
 *
 * La llave lleva el tenant porque los hijos por negocio (`*.tenant`) comparten
 * nombre y SÍ deben correr en paralelo: ese paralelismo es el sentido del patrón
 * padre/hijo del §39. Los repetibles no traen tenant, así que su llave es el
 * nombre solo y nunca se solapan consigo mismos.
 */
export function sinSolaparse<T>(
  correr: (job: { name: string; data: unknown }) => Promise<T>,
  candado?: CandadoCompartido,
  avisar: (mensaje: string) => void = (m) => console.warn(m),
): (job: { name: string; data: unknown }) => Promise<T | Saltado> {
  const enCurso = new Set<string>();
  return async (job) => {
    const llave = llaveDelJob(job);
    if (enCurso.has(llave)) {
      avisar(`scheduled: ${job.name} todavía corre de la pasada anterior; esta se salta`);
      return { skipped: true, reason: 'la pasada anterior no ha terminado' };
    }
    // El candado compartido se pide DESPUÉS del de memoria: si esta misma
    // réplica ya lo tiene, pedirlo otra vez a Redis diría "no" y quedaríamos
    // reportando "otro proceso" cuando el otro proceso somos nosotros.
    if (candado && !(await candado.tomar(llave, CANDADO_TTL_MS))) {
      avisar(`scheduled: ${job.name} corre en otro proceso; esta pasada se salta`);
      return { skipped: true, reason: 'la pasada anterior corre en otro proceso' };
    }
    enCurso.add(llave);
    try {
      return await correr(job);
    } finally {
      enCurso.delete(llave);
      if (candado) await candado.soltar(llave);
    }
  };
}

export function llaveDelJob(job: { name: string; data: unknown }): string {
  const tenantId = (job.data as { tenantId?: string } | null)?.tenantId;
  return `${job.name}:${tenantId ?? ''}`;
}
