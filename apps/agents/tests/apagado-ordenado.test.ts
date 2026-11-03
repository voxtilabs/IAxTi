import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { alApagar, apagarOrdenado } from '@iaxti/telemetry';

/**
 * Al desplegar, la generación en vuelo se termina (#1216).
 *
 * `apps/workers` drena desde siempre y el proceso que de verdad genera no lo
 * hacía: el SIGKILL lo cortaba a mitad. Lo caro no era perder el trabajo
 * —BullMQ lo reintenta— sino lo que pasa si muere DESPUÉS de haber entregado
 * la respuesta: el reintento la manda otra vez y el cliente recibe dos.
 *
 * Esto NO es una guarda de fuente: monta una cola de verdad y un worker de
 * verdad, mete un job que tarda, dispara el apagado a mitad y mira qué pasó.
 * La pregunta es «¿qué ocurre cuando alguien despliega?», y eso solo se
 * contesta ejercitándolo.
 */
const URL_REDIS = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1';
const COLA = `prueba-apagado-${process.pid}`;
const conexiones: IORedis[] = [];
const conexion = () => {
  const c = new IORedis(URL_REDIS, { maxRetriesPerRequest: null });
  conexiones.push(c);
  return c;
};

afterAll(async () => {
  await Promise.all(conexiones.map((c) => c.quit().catch(() => {})));
});

describe('el apagado espera a la generación en vuelo (#1216)', () => {
  it('termina el job que está corriendo y NO toma el siguiente', async () => {
    const cola = new Queue(COLA, { connection: conexion() });
    await cola.obliterate({ force: true }).catch(() => {});

    const terminados: string[] = [];
    const empezados: string[] = [];
    let arrancoElPrimero: () => void;
    const primeroEnMarcha = new Promise<void>((listo) => { arrancoElPrimero = listo; });

    const worker = new Worker(
      COLA,
      async (job) => {
        empezados.push(job.name);
        if (job.name === 'lento') arrancoElPrimero();
        // Más de lo que tarda el apagado en pedirlo: si `close()` no esperara,
        // esta línea no llegaría a correr y `terminados` quedaría vacío.
        await new Promise((listo) => setTimeout(listo, 900));
        terminados.push(job.name);
      },
      { connection: conexion(), concurrency: 1 },
    );
    await worker.waitUntilReady();
    // El registro es LO QUE SE PRUEBA: sin esta línea `apagarOrdenado` cierra
    // cero piezas y vuelve en 87 ms dejando el job a medias. Lo vi al escribir
    // esto —la prueba falló con `terminados` vacío— y es exactamente lo que
    // pasaba en producción: el mecanismo existía y nadie lo enganchaba.
    alApagar('worker de prueba', () => worker.close());

    await cola.add('lento', {});
    await primeroEnMarcha;
    // El segundo entra a la cola CON el primero en vuelo: es el que no debe
    // tomarse una vez empezado el apagado.
    await cola.add('siguiente', {});

    await apagarOrdenado('prueba');

    expect(terminados).toEqual(['lento']);
    expect(empezados).toEqual(['lento']);

    // Y sigue en la cola para el proceso que venga: drenar no es descartar.
    const esperando = await cola.getWaitingCount();
    expect(esperando).toBe(1);
    await cola.obliterate({ force: true }).catch(() => {});
    await cola.close();
  }, 20_000);
});

/**
 * Lo anterior prueba el mecanismo; esto prueba que el entrypoint lo USA. Son
 * dos preguntas distintas: el mecanismo vive en `@iaxti/telemetry` y ya lo
 * usaba workers, y lo que estaba roto era justamente el cableado de acá.
 */
describe('el entrypoint de agents lo tiene cableado', () => {
  const AGENTS = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');

  it('toma las señales y registra worker, base y sondas', () => {
    expect(AGENTS).toContain('instalarApagadoOrdenado()');
    expect(AGENTS).toMatch(/alApagar\('worker de cola agents'/);
    expect(AGENTS).toMatch(/alApagar\('base de datos'/);
    expect(AGENTS).toMatch(/alApagar\('servidor de sondas'/);
  });

  /**
   * El orden importa y no es decorativo: el worker usa la base mientras
   * drena, así que cerrarla antes rompe el job que se está terminando — que
   * es justo el que esto existe para salvar.
   */
  it('el worker se drena ANTES de cerrar la base', () => {
    const worker = AGENTS.indexOf("alApagar('worker de cola agents'");
    const base = AGENTS.indexOf("alApagar('base de datos'");
    expect(worker).toBeGreaterThan(-1);
    expect(base).toBeGreaterThan(worker);
  });
});
