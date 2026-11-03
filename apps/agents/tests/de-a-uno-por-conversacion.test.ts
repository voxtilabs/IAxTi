import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';
import { DelayedError, type Job } from 'bullmq';
import type { ModuleJobData } from '@iaxti/core';
import {
  CANDADO_MS,
  ESPERA_MS,
  deAUnoPorConversacion,
  type Candado,
} from '../src/de-a-uno-por-conversacion';

/**
 * La cola de la IA en paralelo, pero de a uno por conversación (#1214).
 *
 * El candado va falseado a propósito: lo que hay que probar es la DECISIÓN
 * —pasar, aplazar, soltar— y no que Redis sepa poner una llave. Con Redis de
 * verdad, los cuatro casos de abajo serían una prueba lenta que además
 * depende de que el contenedor esté arriba.
 */
const jobFalso = (data: Record<string, unknown>) => {
  const job = {
    data: data as ModuleJobData,
    moveToDelayed: vi.fn(async () => {}),
  };
  return job as unknown as Job<ModuleJobData> & { moveToDelayed: ReturnType<typeof vi.fn> };
};

const candadoQue = (resultado: boolean): Candado & { tomados: string[]; sueltos: string[] } => {
  const tomados: string[] = [];
  const sueltos: string[] = [];
  return {
    tomados,
    sueltos,
    async tomar(llave) {
      tomados.push(llave);
      return resultado;
    },
    async soltar(llave) {
      sueltos.push(llave);
    },
  };
};

describe('de a uno por conversación (#1214)', () => {
  it('con el candado libre procesa y lo suelta', async () => {
    const candado = candadoQue(true);
    const procesar = vi.fn(async () => ({ ok: true }));
    const job = jobFalso({ tenantId: 't1', conversationId: 'c1' });
    await expect(deAUnoPorConversacion(candado, procesar)(job, 'tok')).resolves.toEqual({ ok: true });
    expect(procesar).toHaveBeenCalledOnce();
    expect(candado.tomados).toEqual(['agents:conv:t1:c1']);
    expect(candado.sueltos).toEqual(['agents:conv:t1:c1']);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  /**
   * El segundo mensaje se APLAZA, no se saltea.
   *
   * Si se salteara, alguien que escribe dos veces seguidas —lo que hace
   * cualquiera con apuro— se quedaría sin respuesta a la segunda, y en la
   * bandeja no se vería nada raro.
   */
  it('con el candado tomado aplaza el job y NO procesa', async () => {
    const candado = candadoQue(false);
    const procesar = vi.fn(async () => ({ ok: true }));
    const job = jobFalso({ tenantId: 't1', conversationId: 'c1' });
    await expect(deAUnoPorConversacion(candado, procesar)(job, 'tok')).rejects.toThrow(DelayedError);
    expect(procesar).not.toHaveBeenCalled();
    expect(job.moveToDelayed).toHaveBeenCalledOnce();
    const [cuando, token] = job.moveToDelayed.mock.calls[0];
    expect(token).toBe('tok');
    // Aplazado hacia adelante, no al pasado: `moveToDelayed` toma un instante
    // absoluto y pasarle el intervalo suelto lo haría elegible al instante.
    expect(cuando).toBeGreaterThan(Date.now() + ESPERA_MS - 1_000);
    // Y no se suelta lo que no se tomó.
    expect(candado.sueltos).toEqual([]);
  });

  /**
   * Y si la generación falla, el candado se suelta igual.
   *
   * Sin esto, un error del modelo dejaría esa conversación aplazándose hasta
   * que venza el candado —dos minutos— por algo que ya terminó.
   */
  it('un fallo del procesador suelta el candado', async () => {
    const candado = candadoQue(true);
    const procesar = vi.fn(async () => {
      throw new Error('el modelo se cayó');
    });
    const job = jobFalso({ tenantId: 't1', conversationId: 'c1' });
    await expect(deAUnoPorConversacion(candado, procesar)(job, 'tok')).rejects.toThrow('el modelo se cayó');
    expect(candado.sueltos).toEqual(['agents:conv:t1:c1']);
  });

  /**
   * Un job sin conversación no puede pisar a nadie, y sobre todo: no se le
   * inventa una llave con `undefined` adentro. Con `agents:conv:undefined`,
   * dos jobs que no tienen nada que ver se serializarían entre sí.
   */
  it('sin conversación pasa directo y no toma ningún candado', async () => {
    const candado = candadoQue(true);
    const procesar = vi.fn(async () => ({ ok: true }));
    const sinConv = jobFalso({ tenantId: 't1' });
    await deAUnoPorConversacion(candado, procesar)(sinConv, 'tok');
    const sinTenant = jobFalso({ conversationId: 'c1' });
    await deAUnoPorConversacion(candado, procesar)(sinTenant, 'tok');
    expect(procesar).toHaveBeenCalledTimes(2);
    expect(candado.tomados).toEqual([]);
  });

  it('el candado caduca solo: si el proceso muere, la conversación no queda muda', () => {
    expect(CANDADO_MS).toBeGreaterThan(30_000);
  });
});

/**
 * Y que el worker de verdad corra en paralelo, mirado en el entrypoint.
 *
 * No se puede comprobar llamando a una función: la decisión vive en
 * `main.ts`, que abre un servidor y se conecta a Redis y a Postgres en cuanto
 * se importa. Mismo instrumento, y por el mismo motivo, que la guarda de
 * `WORKERS_SCHEDULED_CONCURRENCY` en apps/workers.
 *
 * La fuente se escanea LIMPIA (#569): si no, el comentario que explica esta
 * decisión —que nombra la concurrencia y los 82 s— haría pasar la guarda sin
 * que la línea exista.
 */
describe('el worker de la IA corre en paralelo (#1214)', () => {
  const MAIN = fuenteLimpia(readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8'));

  it('la concurrencia sale del entorno y su defecto es mayor que uno', () => {
    expect(MAIN).toMatch(/agentsWorker\.concurrency = enteroDeEntorno\('AGENTS_CONCURRENCY', [2-9]/);
  });

  it('y pasa por la serialización por conversación', () => {
    expect(MAIN).toMatch(/deAUnoPorConversacion\(candadoEnRedis\(/);
  });
});
